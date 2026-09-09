#!/bin/bash
set -euo pipefail

ENDPOINT="${DYNAMODB_ENDPOINT:-http://localhost:8000}"
TABLE="${DYNAMODB_DOMAIN_OUTBOX_TABLE:-domain_outbox}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-local}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-local}"
export AWS_DEFAULT_REGION="${AWS_REGION:-eu-central-1}"

if aws dynamodb describe-table --endpoint-url "$ENDPOINT" --table-name "$TABLE" >/dev/null 2>&1; then
  echo "Table '$TABLE' already exists."
  exit 0
fi

aws dynamodb create-table --endpoint-url "$ENDPOINT" --table-name "$TABLE" \
  --attribute-definitions \
    AttributeName=pk,AttributeType=S \
    AttributeName=pendingShard,AttributeType=S \
    AttributeName=availableAt,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --global-secondary-indexes '[{"IndexName":"byPendingTime","KeySchema":[{"AttributeName":"pendingShard","KeyType":"HASH"},{"AttributeName":"availableAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' \
  --billing-mode PAY_PER_REQUEST >/dev/null

aws dynamodb update-time-to-live --endpoint-url "$ENDPOINT" --table-name "$TABLE" \
  --time-to-live-specification Enabled=true,AttributeName=expiresAt >/dev/null

echo "Done."
