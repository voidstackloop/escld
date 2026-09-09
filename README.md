# escld

A social media app — posts, comments, likes, follows, moderation — with real-time messaging, WebRTC video/audio calling (mute, camera toggle, screen share, in-call chat, raise hand, and moderator-only call recording), and live streaming (RTMP ingest, HLS delivery via S3/CloudFront).

Built as eight services: a React SPA, a Java/Spring Boot API, two Rust services (WebRTC SFU + messaging, and RTMP live-streaming ingest), three small background workers (transcoding, feed fan-out, trending), and an AWS CDK infrastructure app. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how they fit together.

## Quick start

Requires Docker and Docker Compose.

```bash
docker compose up -d
```

First boot takes a few minutes (Elasticsearch and a couple of model/dependency-heavy image builds). Once everything's healthy:

- **App**: http://localhost:5173
- **Backend API**: http://localhost:8080
- **Calling/messaging**: ws-sfu on http://localhost:4000
- **Trending API**: http://localhost:4100

Sign up, confirm the email code, and you're in. Full local-dev details — what's real vs. emulated, the opt-in monitoring stack, running a single service outside Docker, test commands — are in [`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md).

## Documentation

| Doc | Covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System overview, service inventory, request/data flow, why the services are split the way they are. |
| [`docs/BACKEND.md`](docs/BACKEND.md) | Spring Boot API — every endpoint, domain model, security, rate limiting, error handling. |
| [`docs/FRONTEND.md`](docs/FRONTEND.md) | React app — every route, auth flow, component/hook inventory. |
| [`docs/WS_SFU.md`](docs/WS_SFU.md) | The Rust messaging + calling service — every Socket.IO event, how call recording actually works. |
| [`docs/RTMP.md`](docs/RTMP.md) | The Rust live-streaming ingest service — protocol implementation, the publish→HLS pipeline, S3/CloudFront delivery, stream-key auth. |
| [`docs/BACKGROUND_SERVICES.md`](docs/BACKGROUND_SERVICES.md) | The transcode worker, feed worker, and analytics service. |
| [`docs/DATA_ANALYSIS_AND_FEED_DESIGN.md`](docs/DATA_ANALYSIS_AND_FEED_DESIGN.md) | Proposed advanced analytics and personalized-feed architecture, event contracts, ranking model, and delivery roadmap. |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Postgres schema, all five DynamoDB single-table designs, Elasticsearch, Redis. |
| [`docs/AUTH.md`](docs/AUTH.md) | Cognito, JWT validation, role mapping — end to end across all services. |
| [`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md) | All 20 CDK stacks, deployment topology, manually-managed AWS resources. |
| [`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md) | Running everything locally. |

## Repository layout

```
frontend/     React SPA
backend/      Spring Boot API
ws-sfu/       Rust WebRTC SFU + messaging (Socket.IO)
rtmp/         Rust live-streaming RTMP ingest + HLS delivery — see docs/RTMP.md
worker/       ffmpeg transcode worker (SQS-driven)
feed-worker/  Feed fan-out + search indexing worker (SQS-driven)
analytics/    Trending posts/hashtags service (Redis pub/sub)
infra/        AWS CDK — all production infrastructure
aws/          Manually-managed AWS resources (outside CDK) — see docs/INFRASTRUCTURE.md
config/       Local-dev observability config (Prometheus, Grafana, ElasticMQ)
docker-compose.yaml   Full local dev stack
```

## Testing

Each service has its own test suite — see the table at the bottom of [`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md) for exact commands per service (`backend`, `frontend`, `worker`, `feed-worker`, `ws-sfu`, `infra`).

## Deploying

Infrastructure is defined in `infra/` (AWS CDK). `cdk synth` is always safe to run and is how infra changes are verified; `cdk deploy` creates real AWS resources and should never be run casually. See [`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md).
