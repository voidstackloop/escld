#!/bin/bash
# Creates the insights table against the running dynamodb-local container.
# Same role as create_post_hides_table.sh. The real deployment's table is
# provisioned via CDK instead (see infra/lib/insights-stack.ts). Locally,
# rows only ever land here via bq-sink's insights-export.ts pulling from a
# real BigQuery project — a local docker-compose run with no GCP credentials
# configured will have this table exist but stay empty, which is expected.
set -euo pipefail

ENDPOINT="${DYNAMODB_ENDPOINT:-http://localhost:8000}"
TABLE_NAME="${DYNAMODB_INSIGHTS_TABLE:-insights}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-local}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-local}"
export AWS_DEFAULT_REGION="${AWS_REGION:-eu-central-1}"

if aws dynamodb describe-table --endpoint-url "$ENDPOINT" --table-name "$TABLE_NAME" >/dev/null 2>&1; then
    echo "Table '$TABLE_NAME' already exists."
    exit 0
fi

echo "Creating table '$TABLE_NAME'..."
# No GSI — both POST# and CREATOR# series share the sk shape (DATE#...), so
# one range-query access pattern answers both (see infra/lib/insights-stack.ts).
aws dynamodb create-table \
    --endpoint-url "$ENDPOINT" \
    --table-name "$TABLE_NAME" \
    --attribute-definitions \
        AttributeName=pk,AttributeType=S \
        AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null

echo "Done."
