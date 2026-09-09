# Architecture

escld is a social media app (posts, comments, likes, follows, moderation) with real-time messaging, WebRTC video/audio calling, and live streaming, built as eight independently deployable services around a shared Postgres database and a handful of purpose-specific stores.

## Services at a glance

| Service | Language/Runtime | Role | Docs |
|---|---|---|---|
| `frontend` | React 19 / Vite | The SPA — the only thing end users talk to directly. | `docs/FRONTEND.md` |
| `backend` | Java 25 / Spring Boot 4 | Core REST API: posts, comments, likes, follows, moderation, search, media upload. | `docs/BACKEND.md` |
| `ws-sfu` | Rust / mediasoup | Real-time messaging (chat) + WebRTC video/audio calling. Its own Cognito auth, its own DynamoDB table. | `docs/WS_SFU.md` |
| `rtmp` | Rust | Live-streaming RTMP ingest. Accepts an OBS/ffmpeg publish, remuxes to HLS, delivers via S3/CloudFront. EC2, not Fargate — same reason as `ws-sfu`. | `docs/RTMP.md` |
| `worker` | Node / TypeScript | ffmpeg transcoding — turns uploaded video/audio into HLS. SQS-driven. | `docs/BACKGROUND_SERVICES.md` |
| `feed-worker` | Node / TypeScript | Post-created fan-out: text embedding, Elasticsearch indexing, per-follower feed writes. SQS-driven. | `docs/BACKGROUND_SERVICES.md` |
| `analytics` | Node / TypeScript | Trending posts/hashtags. Redis-pub/sub-driven, small read API. | `docs/BACKGROUND_SERVICES.md` |
| `infra` | AWS CDK / TypeScript | All production infrastructure as code. Nothing here deploys itself. | `docs/INFRASTRUCTURE.md` |

Plus `graphify-out/` (dev-tooling output, not application code) — see the bottom of this doc.

The proposed next-generation analytics and recommendation architecture is specified in [`DATA_ANALYSIS_AND_FEED_DESIGN.md`](DATA_ANALYSIS_AND_FEED_DESIGN.md). It documents future behavior rather than the currently deployed service inventory on this page.

## How a request actually flows

**A normal API call** (e.g. loading the feed): `frontend` → `backend` over HTTPS, JWT bearer auth. The backend talks to Postgres (relational core), the relevant DynamoDB table(s), and Elasticsearch (for feed ranking's semantic scoring) synchronously within the request. See `docs/DATA_MODEL.md` for which store owns what.

**Posting something with video/audio**:
```
frontend --(presigned PUT)--> S3
frontend --(POST /posts, mediaKey)--> backend --(SQS: transcode-jobs)--> worker
                                                                            |
                                                    ffmpeg transcode, upload HLS to S3
                                                                            |
                                                    UPDATE posts SET media_status='READY' (Postgres)
```
The post row exists immediately with `media_status=PROCESSING`; the frontend polls/re-fetches and the post becomes playable once `worker` finishes (or `FAILED` after 3 exhausted SQS delivery attempts).

**Every post creation, regardless of media**:
```
backend --(SQS: post-events)--> feed-worker --> embed text, index into Elasticsearch, fan out to followers' DynamoDB feed items
backend --(Redis pub/sub: analytics-events)--> analytics --> record weighted engagement, update trending sorted sets
```
Both are fire-and-forget from the backend's perspective — a failure in either never fails the user's post creation request.

**Warehouse analytics events** use a separate durable path:
```
backend transaction --> Postgres warehouse_outbox --> leased backend relay --> Kafka/MSK --> bq-sink --> BigQuery
```
Relational state and its SQL outbox row commit together. Like, follow, and hide records commit with a v2 event in the shared DynamoDB `domain_outbox` table. Kafka outages leave either kind of outbox record pending; leased relays retry with the same event ID after a failed or ambiguous publish. `bq-sink` accepts both the original v1 envelope and the v2 outbox metadata.

Feed responses issue stateless, viewer-bound observation tokens containing the served post, request, and position. The authenticated `/api/v1/analytics/events` endpoint accepts bounded batches of impression and dwell observations, derives attribution from those tokens, and preserves client event IDs through the SQL outbox for idempotent retries.

**Real-time messaging and calling**: the frontend opens a separate Socket.IO connection directly to `ws-sfu`, authenticated with the same Cognito access token. This is architecturally independent of the backend — `ws-sfu` has its own JWT validation, its own DynamoDB table (`conversations`), and only touches the shared Postgres database read-only (to resolve a Cognito identity to the same `users.id` every other service uses). See `docs/WS_SFU.md`.

**Going live**: `frontend` calls `backend` twice over normal HTTPS — once to mint a stream key (`POST /api/v1/live/stream-key`), once to announce the stream (`POST /api/v1/live/streams`, title + description, creates a real `mediaType=LIVE` Post). The encoder (OBS, ffmpeg) then connects directly to `rtmp` over RTMP (port 1935, not through the ALB) with that stream key as the publish name — `rtmp` validates it against Postgres directly, refuses a publish with no announced stream, remuxes incoming audio/video to HLS via a local `ffmpeg` subprocess, and uploads the output to the same S3 bucket/CloudFront distribution post media already uses. The stream ends either through the app's own "End Stream" button (backend writes Postgres + publishes `live.ended` to Kafka) or by the encoder simply disconnecting (`rtmp` itself detects this and does both). See `docs/RTMP.md`.

## Why this split

The two axes that actually drove separating services (not separation for its own sake):

1. **Stateful vs. stateless.** `backend`, `analytics`, and the two SQS workers are stateless request/queue processors — they scale by adding replicas with no coordination needed. `ws-sfu` is the one genuinely stateful tier (per-room mediasoup state lives in one process's memory), which is why it's the one service that can't just run more Fargate replicas — see `docs/INFRASTRUCTURE.md`.
2. **CPU/IO shape.** ffmpeg transcoding and ONNX embedding are heavy, bursty, and best isolated from the low-latency request path — hence separate SQS-driven workers rather than doing this work inline in the backend request that creates a post.

## Auth, end to end

Covered fully in `docs/AUTH.md` — the short version: Cognito is the only identity provider, Postgres `users` is the only profile store, and Cognito User Pool Groups (`admin`/`moderator`) are the entire authorization model, checked independently by both `backend` and `ws-sfu` (there's no shared auth service).

## Things in the repo that are not active parts of the system

**`graphify-out/`** — output from a code-analysis/knowledge-graph tool (see the repo-root `CLAUDE.md`, which documents how to query it), not application code. Excluded from the rest of this documentation set.

**`aws/`** — not a service; manually-managed AWS artifacts (a Cognito Lambda trigger + IAM policy documents) that sit outside the CDK app. See `docs/INFRASTRUCTURE.md` and `docs/AUTH.md`.
