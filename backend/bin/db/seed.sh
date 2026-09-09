#!/bin/bash
# Applies local dev seed SQL against the running docker-compose postgres container.
set -euo pipefail
cd "$(dirname "$0")"

CONTAINER="${POSTGRES_CONTAINER:-escld-postgres-1}"
DB_USER="${POSTGRES_USER:-escld}"
DB_NAME="${POSTGRES_DB:-escld}"

for f in *.sql; do
    echo "Applying $f..."
    docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$f"
done
