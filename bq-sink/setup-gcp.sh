#!/usr/bin/env bash
# One-time GCP + AWS setup for bq-sink's fifteen current domain and observation event types.
# Requires: gcloud CLI authenticated to the target GCP project, aws CLI
# authenticated to the same AWS account escld is deployed in (only needed to
# read the caller's own account id — nothing here writes to AWS).
#
# This is the manual step nothing in `cdk deploy` can do for you — only a
# human with real GCP account access can create the GCP project/dataset/
# service account and the Workload Identity Federation trust relationship
# that lets the deployed bq-sink ECS task impersonate it. bq-sink
# authenticates via WIF (no service-account key is ever created or stored —
# see gcp-auth.ts): the AWS task role's own identity is federated directly to
# GCP through GCP's Security Token Service. Review each command before
# running; nothing here runs automatically.
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID to your target GCP project}"
: "${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID to the AWS account escld is deployed in (aws sts get-caller-identity)}"
# gcloud's own account-id format validation only fires deep inside the WIF
# provider-creation step below, and that step is wrapped in `|| true` (so a
# duplicate-provider re-run doesn't abort a script that's otherwise
# idempotent everywhere else) — which previously meant a malformed account
# id failed silently there. On a first run that leaves no real provider
# behind at all, surfacing later as an opaque `providers describe` failure;
# on a re-run against an already-correctly-configured project it just no-ops
# harmlessly against the real provider created earlier, which is genuinely
# fine but shouldn't print a bare error either. Validate up front instead,
# before any GCP resource is touched.
if [[ ! "${AWS_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]]; then
  echo "AWS_ACCOUNT_ID must be a plain 12-digit AWS account id (got '${AWS_ACCOUNT_ID}') — run: aws sts get-caller-identity --query Account --output text" >&2
  exit 1
fi
DATASET="${BIGQUERY_DATASET:-escld_events_raw}"
ANALYTICS_DATASET="${BIGQUERY_ANALYTICS_DATASET:-escld_analytics}"
SA_NAME="bq-sink"
SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
# Chosen upfront, not read from a deploy output — infra/lib/bq-sink-service-stack.ts
# gives the ECS task role this exact fixed name specifically so this script's
# WIF trust config never depends on a `cdk deploy` having already happened.
TASK_ROLE_NAME="escld-bq-sink-task-role"
WIF_POOL_ID="escld-bq-sink-pool"
WIF_PROVIDER_ID="escld-bq-sink-aws"

echo "==> Enabling the BigQuery API on ${GCP_PROJECT_ID}"
gcloud services enable bigquery.googleapis.com --project "${GCP_PROJECT_ID}"

echo "==> Creating dataset ${DATASET} (skips if it already exists)"
bq mk --project_id="${GCP_PROJECT_ID}" --dataset "${DATASET}" || true
bq mk --project_id="${GCP_PROJECT_ID}" --dataset "${ANALYTICS_DATASET}" || true

echo "==> Creating landing tables — one per event type (Phase 0+1)"
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_post_created" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,postId:STRING,authorId:STRING \
  || true

bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_post_liked" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,postId:STRING,userId:STRING \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_post_unliked" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,postId:STRING,userId:STRING \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_post_commented" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,postId:STRING,commentId:STRING,authorId:STRING \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_post_comment_deleted" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,postId:STRING,commentId:STRING,commentAuthorId:STRING,deletedById:STRING,deletionReason:STRING \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_post_hidden" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,postId:STRING,userId:STRING \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_post_unhidden" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,postId:STRING,userId:STRING \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_user_followed" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,followerId:STRING,followeeId:STRING \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_user_unfollowed" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,followerId:STRING,followeeId:STRING \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_live_started" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,postId:STRING,authorId:STRING,title:STRING \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_live_ended" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,postId:STRING,authorId:STRING,durationSeconds:INTEGER,peakViewerCount:INTEGER \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_post_impression" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,postId:STRING,requestId:STRING,sessionId:STRING,position:INTEGER,visibleDurationMs:INTEGER,visibleFraction:FLOAT \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_post_dwell" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,postId:STRING,requestId:STRING,sessionId:STRING,position:INTEGER,activeDwellMs:INTEGER,observationSequence:INTEGER \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_feed_served" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,requestId:STRING,itemCount:INTEGER,continuation:BOOLEAN,servedFromSnapshot:BOOLEAN,hasMore:BOOLEAN,orderedItems:JSON \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_media_progress" \
  eventId:STRING,eventVersion:STRING,occurredAt:TIMESTAMP,correlationId:STRING,postId:STRING,requestId:STRING,sessionId:STRING,position:INTEGER,mediaPlayedMs:INTEGER,mediaDurationMs:INTEGER,playbackSequence:INTEGER,milestonePercent:INTEGER \
  || true
bq mk --project_id="${GCP_PROJECT_ID}" --table \
  "${GCP_PROJECT_ID}:${DATASET}.raw_ingestion_errors" \
  quarantinedAt:TIMESTAMP,topic:STRING,partition:INTEGER,offset:STRING,reason:STRING,correlationId:STRING,errorMessage:STRING,rawMessage:STRING \
  || true

# Existing tables predate the v2 outbox envelope. These additions are
# idempotent and keep v1 rows valid with NULL metadata.
for TABLE in \
  raw_post_created raw_post_liked raw_post_unliked raw_post_commented raw_post_comment_deleted raw_post_hidden raw_post_unhidden \
  raw_user_followed raw_user_unfollowed raw_live_started raw_live_ended \
  raw_post_impression raw_post_dwell raw_feed_served raw_media_progress; do
  bq query --project_id="${GCP_PROJECT_ID}" --use_legacy_sql=false \
    "ALTER TABLE \`${GCP_PROJECT_ID}.${DATASET}.${TABLE}\`
       ADD COLUMN IF NOT EXISTS ingestedAt TIMESTAMP,
       ADD COLUMN IF NOT EXISTS producer STRING,
       ADD COLUMN IF NOT EXISTS actorId STRING,
       ADD COLUMN IF NOT EXISTS entityType STRING,
       ADD COLUMN IF NOT EXISTS entityId STRING,
       ADD COLUMN IF NOT EXISTS entityVersion INT64"
done

# Older observation tables used the placeholder dwellMs column before the
# cumulative client contract shipped. Keep it nullable and add canonical fields.
bq query --project_id="${GCP_PROJECT_ID}" --use_legacy_sql=false \
  "ALTER TABLE \`${GCP_PROJECT_ID}.${DATASET}.raw_post_dwell\`
     ADD COLUMN IF NOT EXISTS activeDwellMs INT64,
     ADD COLUMN IF NOT EXISTS observationSequence INT64"
bq query --project_id="${GCP_PROJECT_ID}" --use_legacy_sql=false \
  "ALTER TABLE \`${GCP_PROJECT_ID}.${DATASET}.raw_feed_served\`
     ADD COLUMN IF NOT EXISTS orderedItems JSON"
bq query --project_id="${GCP_PROJECT_ID}" --use_legacy_sql=false \
  "ALTER TABLE \`${GCP_PROJECT_ID}.${DATASET}.raw_ingestion_errors\`
     ADD COLUMN IF NOT EXISTS errorMessage STRING"

for TABLE in \
  raw_post_created raw_post_liked raw_post_unliked raw_post_commented raw_post_comment_deleted raw_post_hidden raw_post_unhidden \
  raw_user_followed raw_user_unfollowed raw_live_started raw_live_ended \
  raw_post_impression raw_post_dwell raw_feed_served raw_media_progress; do
  bq query --project_id="${GCP_PROJECT_ID}" --use_legacy_sql=false \
    "ALTER TABLE \`${GCP_PROJECT_ID}.${DATASET}.${TABLE}\`
       ADD COLUMN IF NOT EXISTS eventType STRING,
       ADD COLUMN IF NOT EXISTS eventPayload JSON,
       ADD COLUMN IF NOT EXISTS sourceTopic STRING,
       ADD COLUMN IF NOT EXISTS sourcePartition INT64,
       ADD COLUMN IF NOT EXISTS sourceOffset STRING"
done

# message-handler.ts always sets experimentId/experimentVariant on every row
# it builds (null when absent), and canonicalizer.ts's canonicalMergeSql
# already SELECTs them as real columns off every raw table — without this,
# a streaming insert of any event (feed.served included, now that
# FeedServiceImpl populates them) fails outright against BigQuery's
# schema-enforced insert instead of just carrying nulls.
for TABLE in \
  raw_post_created raw_post_liked raw_post_unliked raw_post_commented raw_post_comment_deleted raw_post_hidden raw_post_unhidden \
  raw_user_followed raw_user_unfollowed raw_live_started raw_live_ended \
  raw_post_impression raw_post_dwell raw_feed_served raw_media_progress; do
  bq query --project_id="${GCP_PROJECT_ID}" --use_legacy_sql=false \
    "ALTER TABLE \`${GCP_PROJECT_ID}.${DATASET}.${TABLE}\`
       ADD COLUMN IF NOT EXISTS experimentId STRING,
       ADD COLUMN IF NOT EXISTS experimentVariant STRING"
done

echo "==> Creating service account ${SA_EMAIL} (skips if it already exists)"
gcloud iam service-accounts create "${SA_NAME}" \
  --project "${GCP_PROJECT_ID}" \
  --display-name "escld bq-sink (Kafka -> BigQuery bridge)" \
  || true

echo "==> Granting BigQuery Data Editor scoped to each dataset only (not project-wide)"
# The unified Cloud IAM policy API for BigQuery datasets
# (bq add-iam-policy-binding / bq get-iam-policy) returned "This feature
# requires allowlisting" on this account, for both read and write, on a
# project with billing already linked — a project/account-wide gate on that
# specific API, not a permission problem. The older, separate dataset-ACL
# surface (bq show/update --dataset, the same access[] array the BigQuery
# console's own "Share dataset" UI edits) goes through a different API and is
# not gated the same way — confirmed working. Idempotent: only adds the
# entry if it isn't already present, so re-running this script is safe.
grant_dataset_writer() {
  local target_dataset="$1"
  python3 - "${GCP_PROJECT_ID}" "${target_dataset}" "${SA_EMAIL}" <<'PYEOF'
import json
import subprocess
import sys
import tempfile
import os

project_id, dataset, sa_email = sys.argv[1], sys.argv[2], sys.argv[3]
ref = f"{project_id}:{dataset}"
current = json.loads(subprocess.check_output(["bq", "show", "--format=prettyjson", ref]))
access = current.get("access", [])
if any(entry.get("userByEmail") == sa_email and entry.get("role") == "WRITER" for entry in access):
    print(f"    {dataset}: already granted, skipping")
    sys.exit(0)
access.append({"role": "WRITER", "userByEmail": sa_email})
# `bq update --source` requires a real, statable file — it rejects /dev/stdin
# outright ("Source path is not a file"), so this can't be piped in directly.
with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
    json.dump({"access": access}, f)
    acl_path = f.name
try:
    subprocess.run(["bq", "update", f"--source={acl_path}", ref], check=True)
finally:
    os.unlink(acl_path)
print(f"    {dataset}: granted")
PYEOF
}
grant_dataset_writer "${DATASET}"
grant_dataset_writer "${ANALYTICS_DATASET}"

gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/bigquery.jobUser"

echo "==> Setting up Workload Identity Federation (no service-account key, ever)"
gcloud iam workload-identity-pools create "${WIF_POOL_ID}" \
  --project="${GCP_PROJECT_ID}" \
  --location="global" \
  --display-name="escld bq-sink AWS federation" \
  || true

# --attribute-mapping is always required — GCP applies no default mapping.
# attribute.aws_role extracts the bare role name from the caller's
# assumed-role ARN (arn:aws:sts::<account>:assumed-role/<role>/<session>),
# not the full ARN — the workloadIdentityUser binding below matches on that
# bare name, per GCP's own documented syntax.
#
# Only ALREADY_EXISTS is tolerated here (a harmless re-run against a
# provider this script already created correctly) — any other failure
# (bad account id, a real permission problem, etc.) means no working
# provider exists yet, and must fail loudly now rather than resurface as a
# confusing `providers describe` error at the very end of the script, or
# — worse — as an opaque STS `invalid_grant` at container runtime after a
# `cdk deploy` that looked like it succeeded.
if ! CREATE_AWS_OUTPUT=$(gcloud iam workload-identity-pools providers create-aws "${WIF_PROVIDER_ID}" \
  --project="${GCP_PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="${WIF_POOL_ID}" \
  --account-id="${AWS_ACCOUNT_ID}" \
  --attribute-mapping="google.subject=assertion.arn,attribute.account=assertion.account,attribute.aws_role=assertion.arn.extract('assumed-role/{role_name}/')" \
  2>&1); then
  if ! grep -q "ALREADY_EXISTS" <<<"${CREATE_AWS_OUTPUT}"; then
    echo "${CREATE_AWS_OUTPUT}" >&2
    echo "Failed to create the WIF AWS provider (see error above) — nothing after this point can succeed without it. Not continuing." >&2
    exit 1
  fi
  echo "    provider already exists, skipping"
fi

GCP_PROJECT_NUMBER="$(gcloud projects describe "${GCP_PROJECT_ID}" --format='value(projectNumber)')"

echo "==> Allowing the ${TASK_ROLE_NAME} AWS role to impersonate ${SA_EMAIL}"
# On a freshly created service account this can fail once with a plain
# PERMISSION_DENIED on iam.serviceAccounts.setIamPolicy even for the
# project's own Owner — a real IAM propagation delay (observed to clear
# within ~30s), not an actual permission gap. Retry briefly instead of
# reporting a false permission error.
for ATTEMPT in 1 2 3 4 5; do
  if gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
      --project="${GCP_PROJECT_ID}" \
      --role="roles/iam.workloadIdentityUser" \
      --member="principalSet://iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.aws_role/${TASK_ROLE_NAME}"; then
    break
  fi
  if [ "${ATTEMPT}" = "5" ]; then
    echo "Still failing after 5 attempts — this is likely a real permission problem, not propagation delay." >&2
    exit 1
  fi
  echo "    retrying in 15s (attempt ${ATTEMPT}/5, likely IAM propagation delay)..."
  sleep 15
done

# `providers describe` returns the bare "projects/.../providers/..." path —
# external-account credentials need the fully-qualified audience string with
# this prefix. Missing it is a silent-failure gotcha (STS rejects the token
# exchange), not an obvious error.
WIF_PROVIDER_NAME="//iam.googleapis.com/$(gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER_ID}" \
  --project="${GCP_PROJECT_ID}" --location=global \
  --workload-identity-pool="${WIF_POOL_ID}" --format='value(name)')"

echo
echo "Done. Deploy (or redeploy) with:"
echo "  cdk deploy EscldBqSinkServiceStack \\"
echo "    -c bigQueryProjectId=${GCP_PROJECT_ID} \\"
echo "    -c bigQueryDataset=${DATASET} \\"
echo "    -c gcpWorkloadIdentityProvider='${WIF_PROVIDER_NAME}'"
