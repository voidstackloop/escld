#!/bin/bash
# 50k-scale variant of run.sh: seeds 4,000 users / 50,000 posts / ~75,000
# comments / a random follow graph / a synthetic like graph, then drives the
# REAL pipeline (SQS -> feed-worker -> embedding -> Elasticsearch -> DynamoDB
# fan-out) for posts and follows, same as the 1000-scale version. Comments
# and likes are seeded directly (no async pipeline exists for either in the
# real app either — comment creation is a synchronous Postgres write, and
# likes only need to exist for read-path load testing here, not to prove the
# write path itself, which the 1000-scale test and LikeStoreDynamoDbIntegrationTest
# already cover).
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

feed_worker_health() {
    docker exec "$FEED_WORKER_CONTAINER" node -e \
        'fetch("http://localhost:8080/health").then(r=>r.text()).then(t=>process.stdout.write(t))' 2>/dev/null || echo '{}'
}

echo "== 1. Seeding Postgres (4000 users, 50000 posts, ~75000 comments, follow-edge export) =="
time docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < seed_50000.sql

echo "== 2. Copying exported CSVs out of the postgres container =="
docker cp "$PG_CONTAINER:/tmp/seed_users.csv" /tmp/seed_users.csv
docker cp "$PG_CONTAINER:/tmp/seed_follows.csv" /tmp/seed_follows.csv
docker cp "$PG_CONTAINER:/tmp/seed_posts.csv" /tmp/seed_posts.csv

echo "== 3. Building DynamoDB/SQS batch request files (follows + post-created events) =="
time python3 generate_batches.py

echo "== 4. Building the synthetic like graph =="
time python3 generate_likes.py
docker cp /tmp/seed_like_counts.csv "$PG_CONTAINER:/tmp/seed_like_counts.csv"

BASELINE_HEALTH=$(feed_worker_health)
BASELINE_SUCCEEDED=$(echo "$BASELINE_HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jobsSucceeded", 0))' 2>/dev/null || echo 0)
BASELINE_FAILED=$(echo "$BASELINE_HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jobsFailed", 0))' 2>/dev/null || echo 0)

echo "== 5. Writing follow graph to DynamoDB (batches of 25 items) =="
i=0
total=$(ls /tmp/loadtest_batches/follows_*.json 2>/dev/null | wc -l)
for f in /tmp/loadtest_batches/follows_*.json; do
    aws dynamodb batch-write-item --endpoint-url "$DYNAMO_URL" --request-items "file://$f" >/dev/null
    i=$((i + 1))
    if [ $((i % 100)) -eq 0 ]; then echo "  follow batches: $i/$total"; fi
done
echo "  follow batches: $i/$total done"

echo "== 6. Writing like graph to DynamoDB (batches of 25 items) =="
i=0
total=$(ls /tmp/loadtest_batches/likes_*.json 2>/dev/null | wc -l)
for f in /tmp/loadtest_batches/likes_*.json; do
    aws dynamodb batch-write-item --endpoint-url "$DYNAMO_URL" --request-items "file://$f" >/dev/null
    i=$((i + 1))
    if [ $((i % 100)) -eq 0 ]; then echo "  like batches: $i/$total"; fi
done
echo "  like batches: $i/$total done"

echo "== 7. Applying like counts to posts.like_count =="
docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < apply_like_counts.sql

echo "== 8. Publishing post-created events to SQS (batches of 10) =="
i=0
total=$(ls /tmp/loadtest_batches/events_*.json 2>/dev/null | wc -l)
for f in /tmp/loadtest_batches/events_*.json; do
    aws sqs send-message-batch --endpoint-url "$SQS_URL" --queue-url "$QUEUE_URL" --entries "file://$f" >/dev/null
    i=$((i + 1))
    if [ $((i % 200)) -eq 0 ]; then echo "  event batches: $i/$total"; fi
done
echo "  event batches: $i/$total done"

echo "== 9. Waiting for feed-worker to drain the queue (this is the slow part — real embedding compute per post) =="
POST_COUNT=$(wc -l < /tmp/seed_posts.csv)
for attempt in $(seq 1 360); do
    HEALTH=$(feed_worker_health)
    SUCCEEDED=$(echo "$HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jobsSucceeded", 0))' 2>/dev/null || echo 0)
    FAILED=$(echo "$HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jobsFailed", 0))' 2>/dev/null || echo 0)
    DONE=$((SUCCEEDED - BASELINE_SUCCEEDED))
    NEW_FAILED=$((FAILED - BASELINE_FAILED))
    echo "  processed so far: $DONE/$POST_COUNT (failed: $NEW_FAILED)"
    if [ "$DONE" -ge "$POST_COUNT" ]; then
        break
    fi
    sleep 10
done

echo "== Done. Run bin/loadtest/report.sh to inspect the results. =="
