# Local Development

Everything runs via Docker Compose (`docker-compose.yaml` at the repo root) — real Postgres/Redis/Elasticsearch images, plus **local emulators** standing in for the AWS services production uses.

## Quick start

```bash
docker compose up -d
```

This starts every application service and its real dependencies. First boot pulls/builds several images and can take a few minutes (Elasticsearch and the ffmpeg/ONNX-model-bearing images are the biggest).

Once healthy:

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8080 (actuator/metrics on :9090) |
| ws-sfu (calling + messaging) | http://localhost:4000 |
| Analytics | http://localhost:4100 |

To bring it back down: `docker compose down` (add `-v` to also drop the named volumes — Postgres/Redis/Elasticsearch/DynamoDB data).

## Services and what emulates what

| Service | Image / build | Notes |
|---|---|---|
| `postgres` | `postgres:17` | Real Postgres, `shared_buffers=128MB`, `max_connections=50` — tuned down for a laptop, not a production setting. |
| `redis` | `redis:latest` | Real Redis, 128MB `allkeys-lru`. |
| `elasticsearch` | `elasticsearch:9.4.3` | Real Elasticsearch, single-node, security disabled. Version pinned to match the Java/Node client libraries' major version — see `docs/INFRASTRUCTURE.md` for why that match matters. |
| `dynamodb-local` | `amazon/dynamodb-local:3.3.0` | **Emulates DynamoDB.** Runs with `-dbPath` (not `-inMemory`) and a named volume — an earlier `-inMemory` setup silently wiped the whole social graph/feed/moderation data on every container restart, which happened for real during development. |
| `sqs-local` | `softwaremill/elasticmq-native:1.7.1` | **Emulates SQS**, config at `config/elasticmq.conf`. Backs the `transcode-jobs` and `post-events` queues. |
| `backend` | builds `./backend` | Spring Boot API. `JAVA_TOOL_OPTIONS=-Xmx2048m` is set explicitly — without it the JVM defaults to ~25% of whatever memory it *sees*, which with no other cgroup limit meant the full host RAM, a multi-GB phantom reservation for a small dev app. |
| `worker` | builds `./worker` | ffmpeg transcode worker. |
| `feed-worker` | builds `./feed-worker` | Fan-out + search indexing worker. |
| `analytics` | builds `./analytics` | Trending API. |
| `ws-sfu` | builds `./ws-sfu` | Calling + messaging. `MEDIASOUP_WORKER_COUNT=2` (vs. one-per-core in production) and `MEDIASOUP_ANNOUNCED_IP=127.0.0.1` — correct only because the browser and the Docker host are the same machine in local dev; see `ws-sfu/src/config.rs` for the production caveat. `RECORDINGS_BUCKET` is intentionally **unset** here (no local S3 emulator in this compose file) — call recording is a real no-op locally, failing cleanly with "no recordings bucket configured" rather than crashing if triggered. |
| `frontend` | `node:22-bookworm-slim` + bind mount | Local-dev convenience only — runs the Vite dev server directly against the repo's `node_modules` via a bind mount, rather than a production Dockerfile build. This is the one service with no `Dockerfile` of its own. |

**What's not emulated locally**: S3 (media uploads and call recordings both need a real bucket; there's no local S3 emulator in this compose file) and Cognito (always the real hosted user pool — there's no local Cognito emulator either, so every environment, including local dev, authenticates against the same real Cognito user pool referenced in `docker-compose.yaml`'s `COGNITO_ISSUER_URI` default).

## Monitoring stack (opt-in)

Prometheus + Grafana + three `*-exporter` sidecars (`postgres-exporter`, `redis-exporter`, `elasticsearch-exporter`) are gated behind a Compose **profile** and do not start with a plain `docker compose up -d`:

```bash
docker compose --profile monitoring up -d
```

| Service | URL | Notes |
|---|---|---|
| Prometheus | http://localhost:9091 | Config at `config/prometheus.yml` + alerting rules at `config/prometheus-rules.yml`. |
| Grafana | http://localhost:3000 | Default login `admin`/`admin` (`GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD` to override). Pre-provisioned dashboards at `config/grafana/dashboards/` (`backend-overview.json`, `infrastructure-overview.json`). |

`ws-sfu` exposes its own Prometheus metrics at `/metrics` (see `docs/WS_SFU.md`) — point a scrape job at `ws-sfu:4000/metrics` if extending `config/prometheus.yml`.

## Health checks

Every application service has a Docker Compose `healthcheck`, and `depends_on: condition: service_healthy` chains ensure things start in the right order (e.g. `backend` waits on Postgres/Redis/Elasticsearch/DynamoDB-local/SQS-local all being healthy first). The backend's health check is worth knowing about specifically: the JRE base image has no `curl`/`wget`, so it speaks raw HTTP over bash's `/dev/tcp` to hit `/actuator/health` on the management port (9090), not the public API port.

## Running a single service outside Docker

Each service's own directory has its normal toolchain — this is faster for tight edit/rebuild loops than rebuilding a Docker image every time:

- **`backend/`**: Maven (`./mvnw spring-boot:run`), needs the rest of the compose stack running for its dependencies (or point its env vars at your own instances).
- **`frontend/`**: `npm run dev` (needs `VITE_*` env vars pointed at wherever the backend/ws-sfu/analytics services actually are).
- **`worker/`, `feed-worker/`, `analytics/`**: `npm run build && npm start`, or `npm run dev` for `tsc --watch`.
- **`ws-sfu/`**: `cargo run` — but note local rustc may be older than this project's pinned toolchain (the Dockerfile uses `rust:1.94-bookworm`, required by a `sqlx` dependency); building via Docker is the reliable path if your local Rust is older.

## Tests

| Service | Command |
|---|---|
| `backend/` | `./mvnw test` (unit + one Testcontainers-backed integration test — see `docs/BACKEND.md`) |
| `frontend/` | `npm test` (Vitest) |
| `worker/`, `feed-worker/`, `analytics/` | `npm run build` (type-check only — no test suite exists in any of the three) |
| `ws-sfu/` | `cargo test` (via Docker if local rustc is too old, per above) |
| `infra/` | `npx jest` — one suite per CDK stack asserting synthesized resource properties |
