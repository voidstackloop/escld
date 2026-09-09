#!/bin/bash
# Load-test the feed pipeline end to end: seeds 1000 synthetic users + posts +
# a random follow graph, then drives the REAL pipeline (SQS -> feed-worker ->
# embedding -> Elasticsearch -> DynamoDB fan-out) instead of writing the
# feed table directly, so this actually exercises the system under load.
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE_DIR="../../.."
PG_CONTAINER="${POSTGRES_CONTAINER:-escld-postgres-1}"
DB_USER="${POSTGRES_USER:-escld}"
DB_NAME="${POSTGRES_DB:-escld}"
SQS_URL="${SQS_URL:-http://localhost:9324}"
QUEUE_URL="${QUEUE_URL:-$SQS_URL/000000000000/post-events}"
DYNAMO_URL="${DYNAMODB_URL:-http://localhost:8000}"
FEED_WORKER_CONTAINER="${FEED_WORKER_CONTAINER:-escld-feed-worker-1}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-local}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-local}"
export AWS_DEFAULT_REGION="${AWS_REGION:-eu-central-1}"

# feed-worker's health port isn't published to the host (same as the
# transcode worker) — check it via `docker exec`, not a host-side curl.
feed_worker_health() {
    docker exec "$FEED_WORKER_CONTAINER" node -e \
        'fetch("http://localhost:8080/health").then(r=>r.text()).then(t=>process.stdout.write(t))' 2>/dev/null || echo '{}'
}

echo "== 1. Seeding Postgres (1000 users, ~1000 posts, follow-edge export) =="
docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < seed_1000.sql

echo "== 2. Copying exported CSVs out of the postgres container =="
docker cp "$PG_CONTAINER:/tmp/seed_users.csv" /tmp/seed_users.csv
docker cp "$PG_CONTAINER:/tmp/seed_follows.csv" /tmp/seed_follows.csv
docker cp "$PG_CONTAINER:/tmp/seed_posts.csv" /tmp/seed_posts.csv

echo "== 3. Building DynamoDB/SQS batch request files =="
python3 generate_batches.py

BASELINE_HEALTH=$(feed_worker_health)
BASELINE_SUCCEEDED=$(echo "$BASELINE_HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jobsSucceeded", 0))' 2>/dev/null || echo 0)
BASELINE_FAILED=$(echo "$BASELINE_HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jobsFailed", 0))' 2>/dev/null || echo 0)

echo "== 4. Writing follow graph to DynamoDB (batches of 25 items) =="
i=0
total=$(ls /tmp/loadtest_batches/follows_*.json 2>/dev/null | wc -l)
for f in /tmp/loadtest_batches/follows_*.json; do
    aws dynamodb batch-write-item --endpoint-url "$DYNAMO_URL" --request-items "file://$f" >/dev/null
    i=$((i + 1))
    if [ $((i % 50)) -eq 0 ]; then echo "  follow batches: $i/$total"; fi
done
echo "  follow batches: $i/$total done"

echo "== 5. Publishing post-created events to SQS (batches of 10) =="
i=0
total=$(ls /tmp/loadtest_batches/events_*.json 2>/dev/null | wc -l)
for f in /tmp/loadtest_batches/events_*.json; do
    aws sqs send-message-batch --endpoint-url "$SQS_URL" --queue-url "$QUEUE_URL" --entries "file://$f" >/dev/null
    i=$((i + 1))
    if [ $((i % 20)) -eq 0 ]; then echo "  event batches: $i/$total"; fi
done
echo "  event batches: $i/$total done"

echo "== 6. Waiting for feed-worker to drain the queue =="
POST_COUNT=$(wc -l < /tmp/seed_posts.csv)
for attempt in $(seq 1 90); do
    HEALTH=$(feed_worker_health)
    SUCCEEDED=$(echo "$HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jobsSucceeded", 0))' 2>/dev/null || echo 0)
    FAILED=$(echo "$HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jobsFailed", 0))' 2>/dev/null || echo 0)
    DONE=$((SUCCEEDED - BASELINE_SUCCEEDED))
    NEW_FAILED=$((FAILED - BASELINE_FAILED))
    echo "  processed so far: $DONE/$POST_COUNT (failed: $NEW_FAILED)"
    if [ "$DONE" -ge "$POST_COUNT" ]; then
        break
    fi
    sleep 5
done

echo "== Done. Run bin/loadtest/report.sh to inspect the results. =="
