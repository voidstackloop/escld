# Background Services

Three small Node/TypeScript services, each doing one job off the request path. All three run on Node 22, all three expose a `GET /health` liveness endpoint on `HEALTH_PORT`/`PORT`, and the two SQS-driven ones share a near-identical poll/process/shutdown shape.

## `worker` — ffmpeg transcode worker

Consumes the `transcode-jobs` SQS queue (published by the backend's `TranscodeJobPublisher` whenever a post is created with video/audio media).

**Per job** (`src/index.ts` → `processJob`):
1. Download the source file from S3 to a temp dir.
2. `ffmpeg`/`ffprobe` (`src/ffmpeg.ts`) probe the source resolution, then transcode to **HLS** with a resolution ladder that never upscales — video renditions at 1080p/720p/480p (whichever are ≤ the source height), audio-only falls back to a 128k/64k AAC ladder if there's no video stream.
3. Upload the resulting HLS segments/playlists to S3 under `posts/{postId}/hls/`.
4. Mark the post `READY` in Postgres with the CloudFront master playlist URL (`markReady`, `src/db.ts`).
5. On the message's **final** allowed attempt (`ApproximateReceiveCount >= SQS_MAX_RECEIVE_COUNT`), mark the post `FAILED` instead and let the message fall through to the DLQ for inspection — earlier attempts fail silently from the client's perspective and just retry (a flaky S3 read or DB hiccup shouldn't surface as a permanent failure).

**Concurrency model:** each unit of `WORKER_CONCURRENCY` runs its own independent SQS receive/process loop ("lane") rather than all of them sharing one batched `ReceiveMessage` call. An earlier version received a batch of N messages and waited for the *entire* batch to finish before receiving again — so one slow transcode (ffmpeg can legitimately take minutes) stalled every other slot in that batch instead of it immediately picking up new work. Independent lanes mean a fast job's slot goes straight back to polling instead of idling behind a straggler.

**Reliability details:**
- **Visibility-timeout heartbeat**: while a job is in flight, its message's visibility timeout is periodically renewed (`ChangeMessageVisibilityCommand`) rather than relying on one fixed window. Without this, a legitimately slow job that outlasts the queue's visibility timeout gets silently redelivered to a second worker mid-processing — wasted work at exactly the moment the system is under the most load.
- **Per-job deadline**: the whole job (download + transcode + upload + DB update, not just the ffmpeg subprocess) runs under an `AbortController`-based timeout, decoupled from the SQS visibility window since the heartbeat above extends that independently. The S3 calls and the ffmpeg subprocess both listen for the abort signal, so a timeout actually cancels the in-flight work rather than just abandoning it.
- `ffmpeg`/`ffprobe` subprocess calls also carry their own explicit timeout (8 min / 30s) as a second line of defense.
- The Postgres `pg.Pool` has an `error` listener (a network blip on an idle client is otherwise an unhandled `EventEmitter` error that crashes the whole process — a well-known `pg` gotcha) and a `statement_timeout` (30s) so a wedged connection can't hang a query forever.
- `process.on('unhandledRejection'/'uncaughtException')` — a backstop; every real failure path is already caught per-message, this just prevents an unrelated bug from killing the process outright (Node 22 crashes on an unhandled rejection by default).
- S3 reads/writes retry with exponential backoff (`storage.ts`'s `withRetry`, 3 attempts), and bail immediately instead of retrying once the job's deadline has already fired.

## `feed-worker` — fan-out + search indexing

Consumes the `post-events` SQS queue (published by the backend's `PostEventPublisher` on every post creation).

**Per event** (`src/index.ts` → `processEvent`):
1. Embed the post's text into a 384-dim vector (`src/embeddings.ts`, `Xenova/all-MiniLM-L6-v2`, runs fully on-CPU via ONNX — no external API call, no GPU). An empty/media-only post gets an all-zero vector (undefined cosine similarity, so it naturally scores as unrelated rather than corrupting the reranker). Model weights (~90MB) are baked into the Docker image at build time; loading them into memory is deferred to the first real event rather than at process startup, so an idle worker (the common case between bursts of posts) isn't holding the model in RAM for nothing.
2. Index the post + embedding into Elasticsearch (`posts_search`).
3. Fan out a feed item to every follower's DynamoDB `feed` partition, plus the author's own (everyone sees their own posts in their feed too) — see `src/dynamo.ts`'s `FeedFanout`.

**Fan-out details worth knowing:** a very-followed account's post can mean tens of thousands of DynamoDB writes — the classic "celebrity problem." Writes are batched (`BatchWriteItemCommand`, 25 items/batch) with **bounded concurrency** (10 concurrent batch-writers) rather than one-batch-at-a-time — the original one-at-a-time approach held the SQS message (and its visibility timeout) for however long the whole follower list took. Each write is naturally idempotent (deterministic `pk`/`sk`, so a redelivered event just overwrites the same items), and unprocessed batch items retry with backoff up to 5 attempts before being logged and dropped.

**Concurrency model and reliability details:** same independent-lane pool as `worker` (above), for the same reason — a slow fan-out no longer stalls other slots in a shared batch. Also shares the visibility-timeout heartbeat and per-job deadline pattern, with one difference: neither the Elasticsearch client nor the DynamoDB SDK calls are wired to the deadline's abort signal, so a timeout here frees the lane to keep receiving new work but doesn't kill the underlying call — it keeps running detached until it finishes on its own. That's safe because both the ES index write and the DynamoDB fan-out are idempotent, but it means the timeout bounds lane availability, not the wasted work itself. The Elasticsearch client also has an explicit `requestTimeout` (15s) so a stalled connection can't hang the index call indefinitely.

The embedding pipeline promise also had a real wedge bug — `pipelinePromise ??= pipeline(...)` never retried after a rejection, since a rejected promise is neither `null` nor `undefined`. One transient model-load failure (e.g. a disk hiccup) would have permanently broken that process's embedding capability for its entire remaining lifetime, invisibly — the health check is liveness-only and wouldn't have caught it. Fixed to clear the cached promise on rejection so the next call retries loading fresh.

## `analytics` — trending posts/hashtags

A small Express service, **not** SQS-driven — subscribes to a Redis pub/sub channel (`analytics-events`, published by the backend's `AnalyticsEventPublisher`) and serves a tiny read API.

**Event handling** (`src/events.ts`): each `post_created`/`post_liked`/`post_commented` event is weighted (default 1/3/5 respectively, configurable) and recorded against both the post itself and each of its hashtags.

**Trending store** (`src/trending.ts`): one Redis sorted set per entity type (`trending:posts`, `trending:hashtags`), scored by `ZINCRBY` on each event. A scheduled job (`node-cron`, default every 5 minutes) multiplies every member's score by a decay factor (default 0.85) and prunes anything that decays below a threshold (default 0.05) — this is what makes "trending" mean *recent* activity rather than an all-time cumulative count, and keeps the sorted sets from growing forever with long-dead entries sitting at a near-zero score.

**Reliability/scalability detail:** decay used to be one atomic Lua script that loaded and rewrote the *entire* sorted set (`ZRANGE key 0 -1`) in a single call. Redis executes a Lua script single-threaded and atomically, so that script blocked every other Redis command for its full duration — and this Redis instance also backs the backend's distributed rate limiter (`docs/INFRASTRUCTURE.md`), so a large-enough trending set would have meant a periodic app-wide rate-limit-check stall every five minutes. Invisible at dev scale, a real problem once the trending sets hold thousands of members. Fixed to walk the set with `ZSCAN` in bounded batches (200 members/round trip), pipelining the decay+prune writes per batch — other clients' commands interleave between batches instead of the whole pass blocking at once. The trade is losing single-call atomicity: a `record()` racing a decay pass can leave one score stale by one weighted increment for at most one cycle, which doesn't matter for a trending heuristic.

**API** (`src/server.ts`):

| Method & Path | Description |
|---|---|
| `GET /health` | Liveness. |
| `GET /api/v1/analytics/trending/posts?limit=` | Top posts by trending score (limit clamped 1–50, default 10). |
| `GET /api/v1/analytics/trending/hashtags?limit=` | Top hashtags by trending score. |

The frontend's `TrendingWidget` treats this whole service as best-effort — a failure or empty response just means the widget renders nothing.

## Scalability

All three run as ECS Fargate services with no ALB target group for the two SQS consumers (pure background work) and a target group for `analytics` (it's a real read API). Both SQS-driven services autoscale 1→6 tasks on two independent step-scaling policies against their queue: **queue depth** (`ApproximateNumberOfMessagesVisible`) owns both scale-up and scale-down, not CPU — ffmpeg/embedding jobs are bursty and I/O-bound in a way CPU% tracks poorly, and queue depth is a direct measure of "is work backing up." **Age of the oldest undeleted message** (`ApproximateAgeOfOldestMessage`) is a second, increase-only policy layered on top — depth alone can look healthy even while processing has quietly degraded (lanes keep receiving messages, just slowly, rather than letting them pile up unreceived), so age is the more direct backlog/SLA signal. The two policies never fight over a decrease since only the depth policy scales down. Within one task, `WORKER_CONCURRENCY` independent lanes each run their own `ReceiveMessage`/process loop (see "Concurrency model" above) — no longer bound by SQS's 10-messages-per-call limit, since each lane makes its own call rather than sharing one batch. The transcode worker's task is sized at 1 vCPU / 2GB (bumped from 0.5 vCPU) so `WORKER_CONCURRENCY=3` genuinely concurrent ffmpeg encodes don't just contend for the same core. `analytics` autoscales 2→4 tasks on the shared ALB request-count/CPU pattern used by the rest of the app's HTTP-facing services. See `docs/INFRASTRUCTURE.md` for the exact CDK stacks.
