#!/bin/bash
# Creates the likes table against the running dynamodb-local container. Same
# role as create_table.sh (follows). The real deployment's table is
# provisioned via CDK instead (see infra/lib/likes-stack.ts).
set -euo pipefail

ENDPOINT="${DYNAMODB_ENDPOINT:-http://localhost:8000}"
TABLE_NAME="${DYNAMODB_LIKES_TABLE:-likes}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-local}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-local}"
export AWS_DEFAULT_REGION="${AWS_REGION:-eu-central-1}"

if aws dynamodb describe-table --endpoint-url "$ENDPOINT" --table-name "$TABLE_NAME" >/dev/null 2>&1; then
    echo "Table '$TABLE_NAME' already exists."
    exit 0
fi

echo "Creating table '$TABLE_NAME'..."
# byUserRecency GSI: the base table's sk isn't date-ordered, so feed ranking's
# "this viewer's most recently liked posts" query needs createdAt exposed as
# a real sort key — see infra/lib/likes-stack.ts for the matching prod index
# and why. Keep this script's schema in sync with that CDK definition.
aws dynamodb create-table \
    --endpoint-url "$ENDPOINT" \
    --table-name "$TABLE_NAME" \
    --attribute-definitions \
        AttributeName=pk,AttributeType=S \
        AttributeName=sk,AttributeType=S \
        AttributeName=createdAt,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --global-secondary-indexes \
        '[{"IndexName":"byUserRecency","KeySchema":[{"AttributeName":"pk","KeyType":"HASH"},{"AttributeName":"createdAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"KEYS_ONLY"}}]' \
    --billing-mode PAY_PER_REQUEST >/dev/null

echo "Done."
