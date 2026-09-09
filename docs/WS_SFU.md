# ws-sfu (Rust: messaging + WebRTC calling)

Located at `ws-sfu/`. Rust, `socketioxide` (Socket.IO server) + `axum` + the `mediasoup` crate (WebRTC SFU). One process handles both real-time chat messaging and video/audio calling for the app — they share a Socket.IO connection and a Cognito-authenticated identity, and calls are always scoped to an existing conversation.

## Why this is a separate service from the backend

Real-time WebSocket signaling and WebRTC media are architecturally different from the Java backend's stateless REST API: mediasoup needs long-lived per-room in-memory state (routers, transports, producers/consumers) and, for calling specifically, a stable public IP and a UDP port range clients connect to directly — see `docs/INFRASTRUCTURE.md` for why this runs on a dedicated EC2 instance rather than Fargate like everything else.

## Module layout

| Module | Responsibility |
|---|---|
| `main.rs` | Startup: loads config, builds the Cognito JWKS verifier, connects Postgres + DynamoDB + S3, builds the mediasoup worker pool, wires the axum/Socket.IO server. |
| `config.rs` | Env-var-driven `Config`, mirrors `docker-compose.yaml`'s `ws-sfu` service exactly. |
| `state.rs` | `AppState` — the shared, cheap-to-clone (`Arc`-wrapped) handle passed to every handler: Cognito verifier, Postgres pool, DynamoDB repo, room registry, rate limiters, S3 client. |
| `auth.rs` | `CognitoVerifier` — validates Cognito **access** tokens against the user pool's JWKS (cached, refreshed on unknown `kid` or hourly). |
| `types.rs` | `Identity` (the authenticated principal, resolved once at connect and attached to the socket), `Conversation`, `ChatMessage`. |
| `ws/mod.rs` | Connect-time auth middleware (token → Cognito claims → Postgres user row → `Identity`), registers the `messaging` and `call` handler sets, wires disconnect cleanup. |
| `ws/messaging.rs` | Conversation/message Socket.IO events. |
| `ws/call.rs` | Call Socket.IO events — join/leave, transports, producers/consumers, mute state, raise hand, recording. |
| `ws/live.rs` | Ephemeral, broadcast-only live-stream chat Socket.IO events — see "Live-stream chat" below. |
| `kafka/mod.rs` | Consumes `live.started`/`live.ended` and pushes a real-time feed update to online viewers — see "Real-time feed push" below. |
| `sfu/mod.rs` | `RoomRegistry` — `conversationId -> Room` map, a fixed pool of mediasoup `Worker` processes handed out round-robin. |
| `sfu/room.rs` | `Room` — one mediasoup `Router` + every currently-joined peer's transports/producers/consumers/recording state. |
| `sfu/recording.rs` | Call recording: PlainTransport + ffmpeg capture, S3 upload. |
| `sfu/cleanup.rs` | Shared leave/disconnect logic. |
| `store/postgres.rs` | Read-only: resolves a Cognito `sub` to the canonical Postgres `users.id`/`username`, and whether a post is currently live — this is the one place ws-sfu reads the backend's own database directly. |
| `store/dynamo.rs` | `ConversationsRepo` — full CRUD for the `conversations` DynamoDB table (see `docs/DATA_MODEL.md`). |
| `store/social_graph.rs` | `FollowGraphRepo` — read-only access to the Java backend's `follows` table, used only by `kafka/mod.rs`'s feed push. |
| `rate_limit.rs` | Per-socket token-bucket limiter (governor crate) for `messages:send`. |
| `metrics.rs` | Prometheus metrics at `GET /metrics`. |
| `health.rs` | `GET /health` — plain liveness check. |

## Authentication

Every socket connects with a Cognito **access token** (not an ID token — access tokens carry no `aud` claim, so the same `token_use`/`client_id` checks the backend does are duplicated here in `auth.rs`). On connect:

1. Verify the JWT against the cached JWKS (refetch once on an unrecognized `kid`, matching key rotation).
2. Extract `cognito:groups` as `roles`.
3. Resolve the token's `sub` to a Postgres `users.id`/`username` (`store/postgres.rs`) — this is deliberately the app-wide Postgres id, not the Cognito `sub`, so it lines up with every other service's notion of a user (`ChatMessage.senderId`, call `userId`s, etc.).
4. Attach the resulting `Identity { user_id, username, roles }` to the socket's extensions for every subsequent handler to read.

If the Postgres row doesn't exist yet (a real, legitimate race for a freshly-confirmed signup — the Cognito PostConfirmation Lambda that creates it is fire-and-forget, see `docs/INFRASTRUCTURE.md`), the connection is rejected.

**Roles are enforced, not just carried**: `Identity::has_role("admin"/"moderator")` gates call recording (see below) — the frontend hides the control from non-privileged users, but the server independently checks this on every `call:startRecording`/`call:stopRecording` call, since a hidden button is never a security boundary on its own.

## Messaging (`ws/messaging.rs`)

Persistent chat, backed by the DynamoDB `conversations` table (single-table design — see `docs/DATA_MODEL.md`).

| Event | Direction | Description |
|---|---|---|
| `conversations:list` | client → server | List the caller's conversations (joins the caller's socket to each conversation's Socket.IO room as a side effect, so future messages arrive live). |
| `conversations:openDm` | client → server | Open (or reuse, via the `DMPAIR#` dedup key) a 1:1 conversation. |
| `conversations:createGroup` | client → server | Create a group conversation (2–40 participants). |
| `messages:list` | client → server | Paginated message history for a conversation (also joins the room). |
| `messages:send` | client → server | Send a message (rate-limited — burst 5, refill 1/sec per socket). Broadcasts `messages:new` to the conversation's room. |
| `messages:new` | server → client | New message in a conversation the socket is joined to. |

## Calling (`ws/call.rs`, `sfu/room.rs`)

One mediasoup `Router` per conversation, created lazily on the first `call:join` and torn down once the last peer leaves. **All signaling is custom Socket.IO events** — this app does not use mediasoup's own client-server wire protocol, which matters: there's no automatic cross-peer event propagation (e.g. mediasoup-client's `consumer.on('producerpause')` doesn't exist here), so anything one participant needs another to see — mute state, a raised hand, a recording starting — has to be an explicit server-broadcast event.

Every `call:*` handler re-validates conversation membership on every call (not just at `call:join`), by checking the caller's user id against the DynamoDB conversation's `participant_ids`.

### Core WebRTC signaling

| Event | Description |
|---|---|
| `call:join` | Joins/creates the room; returns the router's RTP capabilities, every other participant's current producers (with live mute state), and current recording status. |
| `call:createTransport` | Creates a send or recv `WebRtcTransport` (the client's first call becomes its send transport, per `use-call.ts`). |
| `call:connectTransport` | Completes DTLS handshake for a transport. |
| `call:produce` | Starts sending a track (mic/camera/screen — tagged via `appData.source`). Broadcasts `call:newProducer` to the room. |
| `call:consume` | Starts receiving another peer's track (created paused; the client resumes once ready). |
| `call:resumeConsumer` | Unpauses a consumer after the client is ready to render it. |
| `call:leave` | Explicit leave — see `sfu/cleanup.rs`. |

### Mute / camera-off

| Event | Description |
|---|---|
| `call:pauseProducer` / `call:resumeProducer` | Pauses/resumes the caller's **own** producer only — ownership is enforced server-side (`Room::find_producer` is scoped to the calling socket), so a peer can never mute someone else's mic by guessing a producer id. Pauses the real mediasoup `Producer` (stops sending RTP), not just the local track. |
| `call:producerStateChanged` | server → client. Broadcast after every pause/resume so every other participant's UI updates immediately. Late joiners get correct initial state too — `ProducerInfo` carries a `paused` flag through `call:join`'s `otherProducers` and `call:newProducer`. |

### Raise hand

| Event | Description |
|---|---|
| `call:raiseHand` / `call:lowerHand` | Ephemeral — relayed to the room, never persisted on the peer. A participant who joins mid-call does not see hands raised before they arrived (a deliberate scope cut, unlike mute state above). |
| `call:handStateChanged` | server → client broadcast. |

### Recording — admin/moderator only

Real server-side capture, not a stub: for every producer currently in the room at the moment recording starts, `sfu/recording.rs`:

1. Opens a mediasoup `PlainTransport` and connects it to a loopback UDP port.
2. Consumes the producer on it (paused, then resumed after a short delay once ffmpeg is confirmed listening — the standard pattern for this kind of mediasoup recording setup).
3. Builds a minimal SDP describing the negotiated codec (payload type/clock rate/channels, pulled from the consumer's own `rtp_parameters` — Opus for audio, VP8 for video, matching the router's configured codec set) and spawns a dedicated `ffmpeg` process per track, piping the RTP to a `.webm` file.
4. Requests a keyframe immediately after resuming (video only), so the recording doesn't sit on a black frame until the producer's next natural keyframe interval.

On stop (explicit `call:stopRecording`, or automatically if the room becomes empty while still recording — see `sfu/cleanup.rs`): sends `SIGINT` to each ffmpeg process (not `SIGKILL`, so it finalizes its container instead of leaving a truncated file), waits up to 10s, then uploads each finished file to a **private** S3 bucket (`recordings/<conversationId>/<recordingId>/<userId>-<source>.webm`) and deletes the local copy.

| Event | Description | Auth |
|---|---|---|
| `call:startRecording` | Starts recording every current producer. Fails cleanly if a recording is already active, if nobody is producing yet, or if no recordings bucket is configured (local dev — see `docs/LOCAL_DEVELOPMENT.md`). | Conversation participant **and** `admin`/`moderator` Cognito group, checked server-side. |
| `call:stopRecording` | Stops and uploads the active recording (async — acks and broadcasts immediately, then finishes the ffmpeg-stop-and-upload sequence in the background so participants aren't left waiting on it). | Same. |
| `call:recordingStateChanged` | server → client broadcast (`{recording, startedByUsername}`) to **every** participant, not just moderators — a passive, non-interactive "recording" indicator is shown to everyone, but only a moderator/admin can see the control or ever access the file. |

**Storage is deliberately isolated from user-reachable media.** Recordings go to their own private S3 bucket (`EscldRecordingsStack`, see `docs/INFRASTRUCTURE.md`) with no CloudFront distribution and no public grants at all — distinct from the bucket used for avatars/post media, which is designed to be publicly readable. ws-sfu's IAM role is granted `PutObject` only, never `GetObject`; there is currently no way for the service itself, or any end user, to read a recording back. That's a deliberate, documented scope cut — an admin-only retrieval tool (e.g. presigned `GetObject` URLs) is a real follow-up, not built yet.

**What's not built**: server-side mixing of multiple participants into a single file (each producer gets its own file — a follow-up if a unified "meeting recording" is ever needed), and auto-including a producer that starts *after* recording begins (recording is a snapshot of who's already in the room, not dynamically updated).

## Live-stream chat (`ws/live.rs`)

Ephemeral, broadcast-only chat for a post currently live-streaming via `rtmp/` (see `docs/RTMP.md`) — deliberately **not** the persisted DM/group `conversations` model above. No DynamoDB write, no message id, no history: chat exists only for as long as someone is connected to the room, matching a Twitch-style live chat's actual value ("what's happening right now"), not a searchable record.

| Event | Description |
|---|---|
| `live:join` | Verifies the target post is actually `live_status = 'LIVE'` via a direct Postgres read (`store/postgres.rs::find_live_post_author`, the same "each Rust service reads shared stores directly" pattern used everywhere else in this app) and, if so, joins the socket to room `live:<postId>`. Anyone authenticated may join — unlike a DM/group, there's no membership list to check. |
| `live:leave` | Leaves the room. No other cleanup needed — Socket.IO already removes a disconnected socket from every room it was in. |
| `live:chat:send` | Rate-limited via a **separate** token bucket from `messages:send` (burst 8, refill 2/sec — deliberately more generous, since a live chat is a faster-moving, more disposable stream than a DM) so live-chatting never eats into a user's DM-sending allowance. Broadcasts `live:chat:new` (`{postId, userId, username, body, sentAt}`) to the room. |

Explicitly deferred, not silently dropped: moderator mute/clear-chat controls, any persistence/replay, and viewer-count surfacing — the last of these already exists separately via the Java backend's `LiveViewerPresenceServiceImpl` Redis heartbeat mechanism, not duplicated here.

## Real-time feed push on going live (`kafka/mod.rs`)

Closes a real gap: without this, a viewer already looking at their feed only discovers a followed creator went live on their *next* fetch, never in real time. A background Kafka consumer (same MSK Serverless cluster and MSK-IAM/OAUTHBEARER auth pattern as `rtmp/src/warehouse.rs`'s producer — see that file's own doc for the exact `aws-msk-iam-sasl-signer`/`rdkafka` OAuth-callback wiring, reused here for a consumer instead) subscribes to `live.started`/`live.ended` — the same Kafka topics both the Java backend and `rtmp/` publish to.

**Delivery is weighted, not a strict broadcast-vs-followers-only binary**: the streamer's online followers receive the push at a near-certain, independently-configured weight (`LIVE_PUSH_FOLLOWER_WEIGHT`, default `1.0`); every other currently-connected user receives it too, but at a much smaller independently-sampled weight (`LIVE_PUSH_DISCOVERY_WEIGHT`, default `0.1`) — a small discovery mechanic, not a full broadcast. Followers are resolved via a new read-only `store/social_graph.rs::FollowGraphRepo`, querying the same `follows` DynamoDB table the Java backend's `FollowGraphStore` owns (schema mirrored exactly: `pk=USER#<id>`, `sk=FOLLOWER#<followerId>`, soft-deleted edges filtered client-side). "Who's currently connected" costs nothing extra to enumerate — `socketioxide`'s `SocketIo::sockets()` already returns every connected socket in the default namespace.

Every authenticated connection joins a `user:<id>` room at connect time (`ws/mod.rs::on_connect`) — a small, generally-reusable primitive this feature needed and any future "push to this specific user" feature can reuse — and delivery targets that room via one batched `io.to(rooms).emit(...)` call for the sampled follower set, plus a direct per-socket `emit` for each sampled discovery-pool hit.

Emits `feed:liveStarted {postId, authorId, authorUsername, title}` / `feed:liveEnded {postId, authorId}` — deliberately a thin "go check again" nudge, not post content itself; the Java backend's own feed ranking/eligibility remains the sole source of truth for what a viewer actually sees.

**A real, easy-to-miss correctness constraint, documented directly in the code**: the consumer's `group.id` is a fresh UUID generated per process start, never a fixed shared value, and `auto.offset.reset=latest`. If `ws-sfu` ever scales horizontally (see "Observability" below for the trigger), a *shared* consumer group across instances would let Kafka partition the work across them — each `live.started`/`live.ended` message would then reach only one instance's consumer, silently breaking delivery to every user connected to any other instance. Entirely inert (consumer never constructed) when no MSK cluster is configured, matching every other optional integration in this app.

## Cleanup (`sfu/cleanup.rs`)

Shared, idempotent logic used by both the explicit `call:leave` event and the raw socket disconnect handler (so a client that vanishes without saying goodbye is still cleaned up correctly, without double-firing events):

1. Remove the peer from the room.
2. If the room is now empty and a recording is active, finish it (stop ffmpeg, upload, clean up) before the room itself is torn down.
3. Broadcast `call:peerLeft`.
4. Drop the room (and its mediasoup `Router`) once nobody's left in it.

## Observability

- `GET /health` — plain `200 ok` liveness check.
- `GET /metrics` — Prometheus text format. Gauges: `ws_sfu_sockets_connected`, `ws_sfu_call_rooms_active`. Counters: `ws_sfu_messages_sent_total`, `ws_sfu_call_producers_total`, `ws_sfu_auth_failures_total`.

These two (`SOCKETS_CONNECTED`/`ROOMS_ACTIVE` in particular) are the intended signal for deciding when vertical scaling of the single ws-sfu instance stops being enough and real horizontal room-affinity routing needs to be built — see `docs/INFRASTRUCTURE.md`.
