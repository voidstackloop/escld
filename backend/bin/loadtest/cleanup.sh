#!/bin/bash
# Removes the load-test seed data. Postgres and Elasticsearch are cleaned up
# surgically (only seed_user_* rows/docs). DynamoDB's follows/feed tables
# run as `dynamodb-local -inMemory` in docker-compose, so the simplest full
# reset for those is restarting the container and recreating the tables —
# this script does that too, which also clears any other local dev data in
# those two tables (fine for local dev, not something to run against a real
# deployment).
set -euo pipefail
cd "$(dirname "$0")"

PG_CONTAINER="${POSTGRES_CONTAINER:-escld-postgres-1}"
DB_USER="${POSTGRES_USER:-escld}"
DB_NAME="${POSTGRES_DB:-escld}"
ES_CONTAINER="${ELASTICSEARCH_CONTAINER:-escld-elasticsearch-1}"

echo "== Postgres: deleting seed_user_* posts/comments/tags/users =="
docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
DELETE FROM comments WHERE post_id IN (
    SELECT p.id FROM posts p JOIN users u ON u.id = p.user_id WHERE u.username LIKE 'seed_user_%'
);
DELETE FROM post_tags WHERE post_id IN (
    SELECT p.id FROM posts p JOIN users u ON u.id = p.user_id WHERE u.username LIKE 'seed_user_%'
);
DELETE FROM posts WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'seed_user_%');
DELETE FROM users WHERE username LIKE 'seed_user_%';
SQL

echo "== Elasticsearch: deleting seed posts from posts_search =="
# Every seed post's text starts with the literal "[SEED]" marker (see
# seed_1000.sql) specifically so cleanup can target them unambiguously.
docker exec -i "$ES_CONTAINER" curl -s -X POST "http://localhost:9200/posts_search/_delete_by_query" \
    -H 'Content-Type: application/json' \
    -d '{"query": {"match_phrase": {"text": "SEED"}}}' >/dev/null

echo "== DynamoDB: resetting dynamodb-local (in-memory) to clear follows/feed =="
docker compose -f ../../../docker-compose.yaml restart dynamodb-local
sleep 3
bash ../dynamodb/create_table.sh
bash ../dynamodb/create_feed_table.sh

echo "Done."
