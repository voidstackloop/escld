# Infrastructure

escld's production infrastructure is defined entirely as AWS CDK (TypeScript) in `infra/`. Nothing here is deployed by default — treat `cdk synth` as the standard way to verify changes; `cdk deploy` is a deliberate, separate action.

## Stack inventory

20 stacks, in the dependency order `infra/bin/infra.ts` creates them:

| Stack | File | Purpose |
|---|---|---|
| `EscldNetworkStack` | `network-stack.ts` | VPC, 2 AZs, public/private-egress/isolated subnet tiers, 1 NAT gateway. |
| `EscldComputeStack` | `compute-stack.ts` | ECS cluster (`escld`, Container Insights, Cloud Map namespace `escld.local`), the shared ALB, `albSecurityGroup`, and `appServiceSecurityGroup` — the one security group shared by every Fargate/EC2 service, created here specifically to avoid a circular stack dependency (see file comment). |
| `EscldDatabaseStack` | `database-stack.ts` | RDS Postgres 17, Multi-AZ, `db.t4g.medium`, credentials in a generated Secrets Manager secret. |
| `EscldCacheStack` | `cache-stack.ts` | Single-node ElastiCache Redis (`cache.t4g.micro`) — used for the backend's Bucket4j rate limiting and the analytics service's pub/sub channel + trending sorted sets. |
| `EscldMediaStack` | `media-stack.ts` | **Public** S3 bucket + CloudFront distribution for user-uploaded avatars/covers/post media. Private bucket, public read only through CloudFront (origin access control), writes via backend-issued presigned PUT URLs. |
| `EscldFrontendStack` | `frontend-stack.ts` | S3 (private) + CloudFront static hosting for the built React SPA, with a SPA-style 403/404 → `/index.html` rewrite. |
| `EscldSocialGraphStack` | `social-graph-stack.ts` | DynamoDB `follows` table (adjacency-list follower/following graph). |
| `EscldTranscodeStack` | `transcode-stack.ts` | SQS `transcode-jobs` queue + `transcode-jobs-dlq` (maxReceiveCount 3, 10 min visibility timeout). |
| `EscldFeedStack` | `feed-stack.ts` | DynamoDB `feed` table (fan-out-on-write per-user feed items). |
| `EscldPostEventsStack` | `post-events-stack.ts` | SQS `post-events` queue + `post-events-dlq` (maxReceiveCount 3, 2 min visibility timeout). |
| `EscldConversationsStack` | `conversations-stack.ts` | DynamoDB `conversations` table backing ws-sfu's messaging (conversations, messages, per-user inbox fan-out, DM dedup). |
| `EscldModerationStack` | `moderation-stack.ts` | DynamoDB `moderation` table (open-report queue + per-moderator audit log). `RemovalPolicy.RETAIN` — the one DynamoDB table here that isn't dev-disposable, on the reasoning that audit/report data should survive a stack teardown. |
| `EscldLikesStack` | `likes-stack.ts` | DynamoDB `likes` table (adjacency-list post likes; the denormalized like *count* stays on the Postgres `posts` row). |
| `EscldSearchStack` | `search-stack.ts` | Self-hosted Elasticsearch 9.4.3 on Fargate (**not** managed OpenSearch — see below), EFS-backed for persistence, single node, addressed at `elasticsearch.escld.local:9200` via Cloud Map. |
| `EscldBackendServiceStack` | `backend-service-stack.ts` | The Spring Boot API as an ECS Fargate service behind the shared ALB (`/api/*`, priority 10), autoscaling 2–8 tasks on CPU + ALB request count. |
| `EscldAnalyticsServiceStack` | `analytics-service-stack.ts` | The analytics/trending Node service as a Fargate service (`/api/v1/analytics/*`, priority 5 — must win over the backend's `/api/*` due to the path overlap), autoscaling 2–4 tasks. |
| `EscldTranscodeWorkerServiceStack` | `transcode-worker-service-stack.ts` | The ffmpeg transcode worker as a Fargate service, no ALB target group (pure SQS consumer), autoscaling 1–6 tasks on `transcode-jobs` queue depth. |
| `EscldFeedWorkerServiceStack` | `feed-worker-service-stack.ts` | The feed/search fan-out worker as a Fargate service, no ALB target group, autoscaling 1–6 tasks on `post-events` queue depth. |
| `EscldRecordingsStack` | `recordings-stack.ts` | **Private** S3 bucket for call recordings — no CloudFront, no public grants at all. Deliberately separate from `EscldMediaStack`'s bucket, which is designed to be public through CloudFront; recordings must never be reachable that way. |
| `EscldWsSfuStack` | `ws-sfu-stack.ts` | The Rust WebRTC SFU + messaging service, on a single EC2 instance (not Fargate — see below), with an Elastic IP for stable WebRTC ICE candidates. |

## Why EC2 for ws-sfu, not Fargate

Every other tier here is stateless or queue-driven and scales by adding replicas. `ws-sfu` can't, for two networking reasons specific to mediasoup:

1. It needs a stable **public IP** for WebRTC ICE candidates (`MEDIASOUP_ANNOUNCED_IP`) — an EC2 instance + Elastic IP gives this directly; Fargate's per-task ENI doesn't.
2. Clients connect **directly** to a UDP port range (40000–40019) for RTP media — this never goes through the ALB, and has to be open to the internet at the security-group level. Fargate has no comfortable way to front a 20-port UDP range for one task.

This is documented in more depth as ADR-002 (see `docs/adr/` if present, or the class doc on `WsSfuStack`): the current choice is **vertical scaling** (bump the instance size + `MEDIASOUP_WORKER_COUNT`, mediasoup runs one worker process per CPU core) with `ROOMS_ACTIVE`/`SOCKETS_CONNECTED` Prometheus metrics as the trigger for building real horizontal room-affinity routing later, if call concurrency ever demands it.

## Why self-hosted Elasticsearch, not managed OpenSearch

Elastic's official client libraries (Java `elasticsearch-java` 9.x used by the backend, `@elastic/elasticsearch` used by `feed-worker`) perform a hard product-compatibility check on connect — they require an `X-Elastic-Product` response header that genuine Elasticsearch sends and AWS OpenSearch does not, and refuse to operate against a cluster that fails it. Moving to OpenSearch would mean swapping both client libraries, not just an infra change — so this stays self-hosted (Fargate + EFS for persistence) to keep the client compatibility the app already depends on.

## Cross-stack dependency shape

`ComputeStack` is created **before** `DatabaseStack`/`CacheStack` specifically so it can own `appServiceSecurityGroup` — every service that needs DB/Redis ingress reads from `DatabaseStack`/`CacheStack`, while `DatabaseStack`/`CacheStack` grant ingress *to* that shared security group. Reversing this (each service creating its own SG, with the DB/cache stacks granting ingress to each) creates a CDK dependency cycle. `ws-sfu`'s EC2 instance also carries this same shared `appServiceSecurityGroup` (via `instance.addSecurityGroup`, since `ec2.Instance` only takes one SG at construction) purely to inherit the Postgres ingress grant — its actual signaling/media ports live on a second, dedicated security group.

## IAM posture worth knowing

- `ws-sfu`'s instance role: ECR pull (its own Docker image), Secrets Manager read (DB credentials), DynamoDB read/write (`conversations` table), and S3 **write-only** (`PutObject` only, no `GetObject`) on the recordings bucket — it uploads recordings but can never read one back. See `docs/WS_SFU.md` for why that matters.
- The media bucket (`EscldMediaStack`) is the one bucket meant to be publicly readable, and only through CloudFront (origin access control) — never directly.
- The recordings bucket (`EscldRecordingsStack`) has `BlockPublicAccess.BLOCK_ALL` and no CloudFront distribution at all — there is currently no read path for a recording from this stack; reading one back (e.g. an admin-only presigned-URL tool) is a deliberately deferred follow-up, not built yet.

## Manually-managed AWS resources (outside CDK)

`aws/` holds artifacts that are provisioned by hand (AWS Console / `aws` CLI), not through CDK:

- **`aws/lambda/postConfirmation/`** — a Cognito PostConfirmation Lambda trigger that provisions the Postgres `users` row once a signup is confirmed (never blocks the signup itself on a DB failure — logs and swallows instead). **Not yet actually wired up as a Cognito trigger or deployed** — see `aws/README.md`; this is a known remaining step (attach via the Amplify auth config or the Cognito console, pointed at a real, network-reachable Postgres instance — the local docker-compose Postgres isn't reachable from a deployed Lambda).
- **`aws/json/`** — IAM policy documents meant to be attached by hand: the postConfirmation Lambda's execution policy, least-privilege S3 media access, and a CloudFront cache-invalidation policy (not yet called from any app code — present for when that's needed). Each has placeholder tokens (`AWS_REGION`, `AWS_ID`, `BUCKET_NANE` — note the typo is in the actual file, `CLOUDFRONT_ID`) to fill in before applying.

## Deploying

```bash
cd infra
npx cdk synth <StackName>      # verify only — always safe
npx cdk deploy <StackName>     # creates real AWS resources — never run without being asked
```

Every stack has a Jest unit test under `infra/test/` asserting its key resource properties (security group rules, IAM grants, table/queue configuration) via `aws-cdk-lib/assertions`. Run `npx jest` from `infra/` before trusting any infra change.
