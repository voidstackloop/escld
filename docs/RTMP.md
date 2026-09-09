# rtmp (Rust: live-streaming ingest server)

Located at `rtmp/`. A from-scratch RTMP protocol server (Rust, `tokio`) that accepts a publish connection from a standard encoder (OBS, ffmpeg) and turns it into a live HLS stream watchable through the app's own CloudFront distribution. No third-party RTMP/streaming-server library is used anywhere — the wire protocol (handshake, chunk stream, AMF0 **and** AMF3) is hand-implemented; ffmpeg is used only for the well-solved FLV→HLS remux step, not for protocol handling.

## Why this is a separate service from the backend

Same reasoning as `ws-sfu` (see `docs/WS_SFU.md`): RTMP needs a single stable public TCP port (`1935`) an encoder connects to directly, which doesn't fit Fargate's `awsvpc` networking the way an EC2 instance + Elastic IP does — see `docs/INFRASTRUCTURE.md`. Unlike `ws-sfu`, there's no Cognito-authenticated signaling channel here at all: the RTMP protocol itself, authenticated by a per-user stream key validated directly against Postgres, is the entire ingest surface.

## Module layout

| Module | Responsibility |
|---|---|
| `main.rs` | Startup: loads config, connects Postgres, builds the S3 client and the warehouse Kafka producer (both unconditionally, both inert without config), spawns the HTTP server, then loops accepting RTMP connections. |
| `config.rs` | Env-var-driven `Config`, mirroring `ws-sfu/src/config.rs`'s shape. Every optional integration (S3 delivery, Redis, MSK) is `Option`-typed and absent-by-default — see "Graceful degradation" below. |
| `store/postgres.rs` | Direct Postgres reads/writes: stream-key → user resolution, the announced-live-post lookup, marking a post `ENDED`/`READY`. The one place this service touches the backend's own database directly (same "Rust service owns its own DB read" pattern as `ws-sfu/src/store/postgres.rs`). |
| `rtmp/handshake.rs` | The plain "simple" RTMP handshake (C0/C1 → S0/S1/S2 → C2) — the fallback handshake every real encoder and every minimal server implementation actually uses, not the HMAC-digest "complex" handshake. |
| `rtmp/chunk.rs` | Chunk-stream reassembly: 1/2/3-byte basic headers, all four message-header formats (fmt 0–3) with field inheritance, the extended-timestamp escape value, and `Set Chunk Size` handled inline. |
| `amf/value.rs`, `amf/amf0.rs`, `amf/amf3.rs`, `amf/constants.rs` | Full AMF0 **and** AMF3 codecs sharing one in-memory `AmfValue` type — see "AMF0 and AMF3" below. |
| `rtmp/command.rs`, `rtmp/writer.rs`, `rtmp/message.rs` | The command layer: parses `connect`/`createStream`/`publish` and writes the exact protocol-control messages and `_result`/`onStatus` responses a real encoder waits for. |
| `rtmp/rtmp.rs` | The session orchestrator (`process`/`handle_connection`) — everything below ties together here. |
| `flv.rs` | Reconstructs incoming RTMP audio/video/data messages as FLV tags — a direct, mechanical transcription (an FLV tag's payload *is* the RTMP message's payload, just with a small restated header), not a transcode. |
| `hls.rs` | Pipes the FLV byte stream into an `ffmpeg` subprocess producing a live fMP4-segmented HLS playlist on local disk, with SIGINT-based graceful shutdown so the final playlist gets its `#EXT-X-ENDLIST` tag. |
| `s3_sync.rs` | Polls that local HLS output and uploads new/changed files to S3 as they appear — the real delivery path (see below). |
| `warehouse.rs` | A best-effort Kafka producer (MSK IAM/OAUTHBEARER auth) publishing `live.ended` for the one path the Java backend can't see: an encoder disconnecting without the app's "End Stream" button being pressed. |
| `live_viewers.rs` | A read-only Redis lookup of the peak-concurrent-viewer count the Java backend's `LiveViewerPresenceServiceImpl` already maintains — needed so a crash-ended stream still gets a real `peak_viewer_count` instead of staying null forever. |
| `http.rs` | A small `axum` server: `/health` for the ALB target group, `/hls/*` serving the local HLS output directory directly (a same-instance fallback/testing path, not the primary delivery mechanism). |

## Authentication: stream keys, not JWTs

There is no login step in the RTMP protocol itself. Instead:

1. A user requests `POST /api/v1/live/stream-key` from the Java backend (authenticated, normal Cognito JWT) — `StreamKeyServiceImpl.regenerate` mints a fresh UUID into `users.stream_key`, overwriting any previous key (one "regenerate" operation, not separate create/rotate endpoints — requesting again *is* rotation, matching how real streaming platforms handle this).
2. The user pastes `rtmp://<host>:1935/live/<streamKey>` into their encoder (OBS, ffmpeg).
3. On `publish`, this server parses the stream name as a UUID and calls `store::postgres::find_by_stream_key` — `SELECT id, username FROM users WHERE stream_key = $1 AND deleted_at IS NULL`. An invalid, never-generated, rotated-away, or soft-deleted-account key all resolve to `None`, and the publish is refused with `NetStream.Publish.BadName` (see `rtmp.rs::handle_command`'s `publish` arm).

**A second, real prerequisite beyond the key itself**: `find_live_post_id_for_user` additionally requires the user to have already announced a stream via `POST /api/v1/live/streams` (title + description, which creates a real `Post` with `mediaType=LIVE`/`liveStatus=LIVE` — see `docs/DATA_MODEL.md`). A valid stream key with no announced stream is refused the same way. This is deliberate, not incidental: it means there is no path for an encoder to start pushing video without a title already on record, so `feed.served`/warehouse analytics never see a titleless live post.

## AMF0 and AMF3

Both AMF (Action Message Format) versions RTMP command/data messages can use are fully implemented, sharing one in-memory `AmfValue` type (`amf/value.rs`) so command-handling code never has to know which wire format produced a given value:

- **AMF0** (`amf/amf0.rs`): every real marker — Number, Boolean, String, Object, ECMA Array, Null, Undefined, Strict Array, Date, Long String, XML Document, Typed Object, and Reference (a back-pointer to an earlier value in the same message, resolved transparently at decode time). MovieClip and RecordSet are deliberately not implemented — both are spec-reserved/dead, and no real encoder ever emits either.
- **AMF3** (`amf/amf3.rs`): the full marker set — undefined, null, false, true, integer (a variable-length 29-bit encoding, U29), double, string, xmlDoc/xml, date, array, object (with the trait/dynamic-member mechanism ActionScript's own object serialization uses), and byteArray — including AMF3's three independent reference tables (strings, "complex" values, and object traits), so a real encoder using back-references decodes correctly. Vector and Dictionary (added by a later spec revision) are deliberately not implemented — no real RTMP live encoder emits either.
- **Per-connection negotiation, not per-message mirroring**: which format this server *responds* with is decided once, from the `connect` command's `objectEncoding` field (`0`/absent = AMF0, `3` = AMF3) — matching the real spec mechanism, not just echoing whatever encoding the immediate incoming message happened to use. Decoding an *incoming* message, by contrast, is always dispatched by that message's own type_id (20 = AMF0 command, 17 = AMF3 command), independent of the negotiated response version.
- **Encoding never emits back-references** in either codec — every value this server sends is written fresh. This is fully spec-legal (references are an optional space-saving device) and means the encode side needs no reference-table bookkeeping at all.

## The publish → HLS pipeline

Once `publish` succeeds (`rtmp.rs::start_publish`):

1. `hls::start` spawns one `ffmpeg` process per stream, reading FLV from `stdin` (`-f flv -i pipe:0`) and writing `-c copy` (no re-encode — this server passes through whatever codec the encoder sent, normally H.264/AAC) fMP4-segmented HLS to `<HLS_DIR>/<streamKey>/live.m3u8` + `segment_%05d.m4s`.
2. `store::postgres::mark_media_ready` flips the announced Post's `media_status` from `PROCESSING` to `READY` — the backend already set a deterministic `mediaUrl` at announce time, but the frontend's existing PROCESSING/READY branch (`post-card.tsx`'s `PostMedia`) keeps showing its placeholder until this fires.
3. If `LIVE_BUCKET_NAME` is configured, `s3_sync::start` begins a poll loop (`S3_SYNC_POLL_MS`, default 100ms) uploading new segments (uploaded exactly once each, long `Cache-Control`, since a segment filename is never reused) and re-uploading the manifest every tick (`Cache-Control: no-cache`) to the same S3 bucket `MediaStack` already serves post images/video from, under a `live/<streamKey>/` prefix.
4. Every subsequent audio/video/data RTMP message is re-muxed into an FLV tag (`flv::write_tag`, writing the FLV file header exactly once on the first tag) and piped into ffmpeg's stdin (`rtmp.rs::forward_to_hls`).

**A real bug found via testing, not by inspection**: `ffmpeg`'s `-hls_fmp4_init_filename` resolves its value relative to the playlist's own directory by plain string concatenation, not a real path join — passing an already-absolute path there doubled the directory prefix and made ffmpeg fail to open the init segment on every single publish, deterministically. The fix (a bare `init.mp4` basename) is documented directly in `hls.rs`.

## Real delivery: S3 + CloudFront, not just local disk

A stream is watchable at `https://<cloudfront-domain>/live/<streamKey>/live.m3u8` — `s3_sync.rs`'s uploads land in `MediaStack`'s existing bucket, served through that same distribution via a dedicated cache behavior scoped to `live/*/live.m3u8` (registered on `MediaStack` itself, not `RtmpServiceStack`, specifically to avoid a cross-stack CloudFormation dependency cycle — `RtmpServiceStack` already depends on `MediaStack` for the bucket, so the reverse reference would close a cycle). Segments need no equivalent cache behavior — immutable once written, they correctly fall through to the default `CACHING_OPTIMIZED` behavior.

The `/hls/*` route through the shared ALB to this instance's own `http.rs` (serving local disk directly) is kept as a same-instance fallback/testing path, not the primary delivery mechanism — genuinely useful for local testing even before CloudFront delivery existed, and costs nothing to leave routed.

### How low the latency actually goes, and why

This delivery path stays exactly S3 + CloudFront — no origin swap, no bypassing the CDN. Within that constraint, latency is squeezed as hard as three independently-tunable levers allow:

1. **Segment length** — `HLS_SEGMENT_SECONDS` defaults to 1 (down from an earlier 4s), `HLS_PLAYLIST_SIZE` to 10. Real segment cuts still only happen at a keyframe boundary under `-c copy` (this server never re-encodes), so the true segment length in practice is bounded below by the encoder's own keyframe interval (OBS defaults to 2s) — worth knowing if a broadcaster wants to tune it further from their own encoder settings, not just this server's config.
2. **Upload cadence** — `S3_SYNC_POLL_MS` defaults to 100ms (down from a hardcoded 1000ms).
3. **CloudFront TTL** — the `live/*/live.m3u8` cache behavior's TTL is pushed to its practical floor (`defaultTtl`/`maxTtl` = 1s, `minTtl` = 0) in `infra/lib/media-stack.ts`.

**Genuine LL-HLS partial segments (`EXT-X-PART`/`EXT-X-PRELOAD-HINT`) are not implemented, and this isn't a version gap to close later** — confirmed directly against a real `ffmpeg -h muxer=hls` run that mainline ffmpeg's `hls` muxer has no partial-segment option surface at all, in any current release. True Apple-spec LL-HLS also needs the CDN/origin to serve *blocking* playlist requests (long-polling until a requested part exists), which a static-object CDN and object store fundamentally can't do regardless of ffmpeg. Realistic latency with the squeeze above: **~2–4s end-to-end** for a real encoder and player (down from ~15–30s before this pass) — a genuine, meaningfully lower number, just not spec-compliant sub-2s LL-HLS.

## Ending a stream: two independent paths, one Postgres write

A live stream ends one of two ways, and both correctly flip `posts.live_status` to `ENDED`:

1. **The app's own "End Stream" button** — `POST /api/v1/live/streams/end` on the Java backend, which also publishes `live.ended` to Kafka via `WarehouseEventPublisher.publishLiveEnded`.
2. **The encoder just disconnects** (crash, network loss, closing OBS without clicking anything) — `rtmp.rs::handle_connection`'s finalize block runs the moment this server's own read loop ends, for any reason. It:
   - Reads the peak-viewer count from Redis (`live_viewers::peak_viewer_count`, best-effort — a Redis miss just leaves the column null).
   - Calls `store::postgres::mark_live_ended`, a single `UPDATE ... WHERE live_status = 'LIVE' RETURNING ...` that sets `live_status`/`live_ended_at`/`peak_viewer_count` together (mirroring the Java backend's own `PostRepository.endLiveStream` — one round trip, not a second write) and returns `Some` only if this call was the one that actually made the transition (not a race with path 1 already having done it).
   - **Only on a real `Some` transition**, publishes `live.ended` itself via `warehouse::WarehouseEventPublisher` — this is the one gap the Java-only publish path could never close on its own, since it only ever runs from the explicit "End Stream" endpoint.
   - Stops ffmpeg (`SIGINT`, not `SIGKILL`, so the playlist gets a real `#EXT-X-ENDLIST`), then stops the S3 sync task (which does one final pass so the fully-finalized playlist actually reaches S3), then schedules local-disk cleanup 30 seconds later — long enough that a viewer's in-flight request for the last segment doesn't 404 the instant the broadcaster disconnects.

The `warehouse.rs` envelope (`eventId`/`eventType`/`eventVersion`/`occurredAt`/`payload`) deliberately mirrors the Java `WarehouseEventPublisher`'s exact shape, so `bq-sink` needs zero changes to parse either producer's messages identically.

## Graceful degradation — every cross-cutting integration is optional

Matching every other best-effort integration in this app, three real dependencies are `Option`-typed in `Config` and never block startup or the publish path when absent:

| Integration | Config | Behavior when absent |
|---|---|---|
| S3/CloudFront delivery | `LIVE_BUCKET_NAME` | `s3_sync` never starts; a stream is reachable only via this instance's own `/hls/*` route. |
| Peak-viewer tracking | `REDIS_HOST` | `peak_viewer_count` stays null for streams that end via crash/disconnect (a stream ended via the app's own button still gets it, from the Java side). |
| `live.ended` on crash/disconnect | `KAFKA_CLUSTER_ARN` | The Postgres `live_status` transition still happens correctly; only the warehouse event is skipped for this one path. |

A real, previously-shipped bug in this exact area: docker-compose's `${VAR:-}` substitution sets a container's env var to a literal empty string when the host-side var is unset, rather than omitting it entirely. A bare `env::var(key).ok()` treats `Some("")` as configured — silently activating a producer against an empty bootstrap-servers string. Every optional value goes through `config::env_opt`, which filters out blank strings, not just missing ones.

## Kafka auth: MSK IAM via a hand-wired OAUTHBEARER callback

No official AWS MSK IAM library exists for Rust the way `aws-msk-iam-auth` (Java) or `aws-msk-iam-sasl-signer-js` (Node, used by `bq-sink`) do. `warehouse.rs`'s `MskOAuthContext` bridges `rdkafka`'s synchronous OAUTHBEARER refresh callback to the community `aws-msk-iam-sasl-signer` crate's async token generator via the crate's own documented pattern: spawn an OS thread, block it on the tokio runtime handle, join it from the sync callback. `aws-sdk-kafka`'s `GetBootstrapBrokers` resolves MSK Serverless's bootstrap brokers at connect time (no static endpoint exists for Serverless clusters) — the same control-plane call the Java backend's `KafkaConfig` makes. A `KAFKA_LOCAL_BOOTSTRAP_SERVERS` escape hatch bypasses all of this for local testing against a plain PLAINTEXT docker-compose broker.

## Infrastructure (`infra/lib/rtmp-service-stack.ts`)

EC2 (not Fargate) + a stable Elastic IP, mirroring `WsSfuStack`'s shape closely:

- **Security group**: TCP `1935` open to `0.0.0.0/0` (any encoder, anywhere — RTMP has no ALB-friendly framing), TCP `4001` open only to the ALB's own security group (health check + the `/hls/*` fallback route).
- **Instance size**: `T3.MEDIUM`, deliberately smaller than `ws-sfu`'s `C6I.XLARGE` — a `-c copy` remux has a genuinely lighter CPU profile than mediasoup's per-connection SFU encoding, not an arbitrary corner cut. Same "vertical scaling first, real room-affinity-style horizontal routing only once data justifies it" precedent as `ws-sfu`.
- **IAM**: `dbSecret.grantRead`, `mediaBucket.grantPut(role, 'live/*')` (write-only — this process never reads back what it uploads, same as `ws-sfu`'s write-only recording-bucket grant), and an MSK `producer`-role grant when `mskClusterArn` is configured.
- **ALB routing**: one listener rule, `/hls/*` → this instance's port `4001` (priority 4).
- **Alarm**: `ServiceDownAlarm` on the target group's healthy-host count, into the shared `MonitoringStack` SNS topic.

## Live chat and real-time feed push live in ws-sfu, not here

Two related capabilities are implemented in `ws-sfu`, not this service: ephemeral, broadcast-only live-stream chat (`ws-sfu/src/ws/live.rs`) and a Kafka-driven `feed:liveStarted`/`feed:liveEnded` push to online viewers when this service's `live.started`/`live.ended` events fire (`ws-sfu/src/kafka/mod.rs`, consuming the same events `warehouse.rs` above and the Java backend both publish). See `docs/WS_SFU.md`. This server's own responsibility stays scoped to ingest and delivery — it never opens a Socket.IO connection itself.

## What's not built

- **No viewer-facing authentication for HLS playback** — a live manifest's URL is not treated as a secret the way the *publish* stream key is; CORS on `http.rs`'s `/hls/*` route is wide open. This mirrors how post media is already public-readable through CloudFront.
- **No re-encoding / adaptive bitrate** — `-c copy` passes through exactly what the encoder sent, no multi-rendition ladder.
- **No horizontal scaling** — one EC2 instance handles every concurrent stream; see "Instance size" above for the deliberate vertical-first posture.
- **No genuine LL-HLS partial segments** — see "How low the latency actually goes, and why" above; this is a real limitation of mainline ffmpeg plus a static-object CDN, not a scope cut.
- **Impression/dwell tracking for live viewership** beyond the peak-concurrent-count this service reads — the same materially bigger, separately-scoped project named throughout `docs/DATA_ANALYSIS_AND_FEED_DESIGN.md`.
