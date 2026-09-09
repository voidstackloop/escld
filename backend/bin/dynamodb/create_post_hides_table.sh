#!/bin/bash
# Creates the post_hides table against the running dynamodb-local container.
# Same role as create_likes_table.sh. The real deployment's table is
# provisioned via CDK instead (see infra/lib/post-hides-stack.ts).
set -euo pipefail

ENDPOINT="${DYNAMODB_ENDPOINT:-http://localhost:8000}"
TABLE_NAME="${DYNAMODB_POST_HIDES_TABLE:-post_hides}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-local}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-local}"
export AWS_DEFAULT_REGION="${AWS_REGION:-eu-central-1}"

if aws dynamodb describe-table --endpoint-url "$ENDPOINT" --table-name "$TABLE_NAME" >/dev/null 2>&1; then
    echo "Table '$TABLE_NAME' already exists."
    exit 0
fi

echo "Creating table '$TABLE_NAME'..."
# No GSI — unlike likes, nothing ever needs a recency-ordered or reverse-edge
# query over hides (see infra/lib/post-hides-stack.ts's own doc for why).
aws dynamodb create-table \
    --endpoint-url "$ENDPOINT" \
    --table-name "$TABLE_NAME" \
    --attribute-definitions \
        AttributeName=pk,AttributeType=S \
        AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null

echo "Done."
