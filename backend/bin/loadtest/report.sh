#!/bin/bash
# Prints a summary of the load-test seed: aggregate counts plus one sample
# user's feed (DynamoDB item count + hydrated posts) so you can see the
# fan-out and semantic ranking actually working, not just row counts.
set -euo pipefail
cd "$(dirname "$0")"

PG_CONTAINER="${POSTGRES_CONTAINER:-escld-postgres-1}"
DB_USER="${POSTGRES_USER:-escld}"
DB_NAME="${POSTGRES_DB:-escld}"
DYNAMO_URL="${DYNAMODB_URL:-http://localhost:8000}"
ES_CONTAINER="${ELASTICSEARCH_CONTAINER:-escld-elasticsearch-1}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-local}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-local}"
export AWS_DEFAULT_REGION="${AWS_REGION:-eu-central-1}"

echo "== Postgres =="
docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT count(*) AS seed_users FROM users WHERE username LIKE 'seed_user_%';"
docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT count(*) AS seed_posts FROM posts p JOIN users u ON u.id = p.user_id WHERE u.username LIKE 'seed_user_%';"
docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT tag, count(*) FROM post_tags GROUP BY tag ORDER BY count(*) DESC;"

echo "== Elasticsearch (posts_search doc count) =="
docker exec -i "$ES_CONTAINER" curl -s "http://localhost:9200/posts_search/_count" | python3 -c 'import json,sys; print(json.load(sys.stdin)["count"])'

echo "== Sample user's feed =="
SAMPLE=$(docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT id || ',' || username FROM users WHERE username LIKE 'seed_user_%' ORDER BY random() LIMIT 1;")
SAMPLE_ID="${SAMPLE%,*}"
SAMPLE_USERNAME="${SAMPLE#*,}"
echo "Sampled user: $SAMPLE_USERNAME ($SAMPLE_ID)"

FEED_ITEMS=$(aws dynamodb query --endpoint-url "$DYNAMO_URL" --table-name feed \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values "{\":pk\":{\"S\":\"USER#${SAMPLE_ID}\"}}" \
  --output json)
FEED_COUNT=$(echo "$FEED_ITEMS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["Items"]))')
echo "Feed items for $SAMPLE_USERNAME: $FEED_COUNT"

echo "First 5 post ids in their feed (newest first):"
echo "$FEED_ITEMS" | python3 -c '
import json, sys
items = json.load(sys.stdin)["Items"]
items.sort(key=lambda i: i["sk"]["S"], reverse=True)
for i in items[:5]:
    print(" -", i["postId"]["S"], i["createdAt"]["S"])
'
