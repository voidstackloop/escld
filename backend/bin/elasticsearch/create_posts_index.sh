#!/bin/bash
# Creates the posts_search index (posts_mapping.json) against the running
# docker-compose elasticsearch container. Same role as seed.sh plays for
# user_search — the app never auto-creates this index (see
# PostSearchDocument's createIndex=false), so this must be run once per
# fresh Elasticsearch volume. No seed data: posts_search is populated by the
# feed worker as posts are created, not from a fixture.
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE_FILE="../../../docker-compose.yaml"
SERVICE="${ELASTICSEARCH_SERVICE:-elasticsearch}"
INDEX="posts_search"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

echo "Creating index '$INDEX' (ignoring if it already exists)..."
compose exec -T "$SERVICE" curl -s -o /dev/null -w 'HTTP %{http_code}\n' \
    -X PUT "http://localhost:9200/$INDEX" \
    -H 'Content-Type: application/json' \
    --data-binary @- <posts_mapping.json

echo "Done."
