#!/bin/bash
# Creates the user_search index (mapping.json) and seeds it from the CURRENT
# Postgres users table — not a static fixture. A hardcoded-UUID fixture here
# previously went stale the moment Postgres got reset/reseeded (a username
# got recreated with a new id, but the old ES doc — keyed by the old id —
# stuck around forever, since nothing reconciles ES against Postgres). See
# backend/src/main/java/com/escld/backend/search/UserSearchIndexer.java for
# the app's own indexing path (keyed by the live Postgres user id), which
# this script now mirrors instead of duplicating fixture data.
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE_FILE="../../../docker-compose.yaml"
ES_SERVICE="${ELASTICSEARCH_SERVICE:-elasticsearch}"
PG_SERVICE="${POSTGRES_SERVICE:-postgres}"
INDEX="user_search"

# Usernames to seed into the search index — pass your own list as args to override.
USERNAMES=("$@")
if [ ${#USERNAMES[@]} -eq 0 ]; then
    USERNAMES=("test12354")
fi

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

echo "Creating index '$INDEX' (ignoring if it already exists)..."
compose exec -T "$ES_SERVICE" curl -s -o /dev/null -w 'HTTP %{http_code}\n' \
    -X PUT "http://localhost:9200/$INDEX" \
    -H 'Content-Type: application/json' \
    --data-binary @- <mapping.json

in_list=""
for name in "${USERNAMES[@]}"; do
    in_list="${in_list}'$(printf '%s' "$name" | sed "s/'/''/g")',"
done
in_list="${in_list%,}"

echo "Reading current data for: ${USERNAMES[*]}"
rows=$(compose exec -T "$PG_SERVICE" psql -U escld -d escld -t -A -F $'\t' -c \
    "SELECT id, username, display_name, COALESCE(bio, ''), COALESCE(avatar_url, ''), is_verified, is_private, followers_count
     FROM users WHERE username IN ($in_list) AND deleted_at IS NULL;")

if [ -z "$rows" ]; then
    echo "No matching users found in Postgres for: ${USERNAMES[*]} — nothing to seed."
    exit 0
fi

bulk_payload=$(echo "$rows" | awk -F'\t' '
    function jesc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return s }
    {
        id = $1; username = jesc($2); displayName = jesc($3); bio = jesc($4); avatarUrl = jesc($5)
        verified = ($6 == "t" ? "true" : "false")
        privateAccount = ($7 == "t" ? "true" : "false")
        followersCount = $8
        printf "{\"index\": {\"_id\": \"%s\"}}\n", id
        bioField = (bio == "" ? "null" : "\"" bio "\"")
        printf "{\"username\": \"%s\", \"displayName\": \"%s\", \"bio\": %s, \"avatarUrl\": \"%s\", \"verified\": %s, \"privateAccount\": %s, \"followersCount\": %s}\n", \
            username, displayName, bioField, avatarUrl, verified, privateAccount, followersCount
    }')

echo "Seeding documents..."
echo "$bulk_payload" | compose exec -T "$ES_SERVICE" curl -s \
    -X POST "http://localhost:9200/$INDEX/_bulk" \
    -H 'Content-Type: application/x-ndjson' \
    --data-binary @-
echo

echo "Refreshing index..."
compose exec -T "$ES_SERVICE" curl -s -X POST "http://localhost:9200/$INDEX/_refresh"
echo
echo "Done."
