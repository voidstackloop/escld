# Data Model

escld splits its data across four stores, deliberately by access pattern rather than by service:

- **Postgres** — the relational core: users, posts, comments, tags. Anything that benefits from joins, constraints, or transactional integrity.
- **DynamoDB** — six single-table designs for high-write, list-heavy, adjacency-list-shaped data: the social graph, the fan-out feed, messaging, moderation, likes, and post hides.
- **Elasticsearch** — full-text + vector search over posts.
- **Redis** — not source-of-truth data, but worth noting here: backend rate-limit token buckets, and the analytics service's trending sorted sets.

## Postgres schema

Managed by Flyway, migrations in `backend/src/main/resources/db/migration/`. Eight migrations exist today:

### `V1__create_users_table.sql` — `users`

One row per Cognito identity (email/password/verification stay in Cognito itself — this is a profile, not a credential store).

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | `gen_random_uuid()` |
| `cognito_sub` | `UUID` | Unique. The Cognito identity this profile belongs to. |
| `username` | `CITEXT` | Unique, case-insensitive. `^[a-zA-Z0-9_]{3,30}$`. |
| `email` | `CITEXT` | Unique, case-insensitive. |
| `display_name` | `VARCHAR(50)` | |
| `bio` | `VARCHAR(160)` | Nullable. |
| `avatar_url`, `cover_image_url` | `TEXT` | Nullable, CloudFront URLs. |
| `location`, `website_url` | | Nullable. |
| `birthdate` | `DATE` | Nullable. |
| `is_verified`, `is_private` | `BOOLEAN` | Default `FALSE`. |
| `status` | `VARCHAR(20)` | `ACTIVE` \| `SUSPENDED` \| `DEACTIVATED`, default `ACTIVE`. |
| `followers_count`, `following_count`, `posts_count` | `INTEGER` | Denormalized counters, `>= 0`. |
| `created_at`, `updated_at` | `TIMESTAMPTZ` | `updated_at` auto-maintained by a `set_updated_at()` trigger (reused by every table below). |
| `deleted_at` | `TIMESTAMPTZ` | Soft-delete marker. |

### `V2__create_posts_table.sql` — `posts`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | |
| `user_id` | `UUID` | FK → `users(id)`. |
| `text` | `VARCHAR(500)` | Nullable — a post needs `text` **or** `media_key`, not necessarily both. |
| `media_type` | `VARCHAR(20)` | Nullable: `IMAGE` \| `VIDEO` \| `AUDIO`. |
| `media_key`, `media_url` | `TEXT` | S3 object key and the resolved playback URL. |
| `media_status` | `VARCHAR(20)` | `NONE` (no media) → `PROCESSING` (queued for ffmpeg transcode) → `READY` (playable — images are `READY` immediately) or `FAILED` (transcode gave up after retries — see `docs/BACKGROUND_SERVICES.md`). |
| `created_at`, `updated_at`, `deleted_at` | | |

Indexed on `(user_id, created_at DESC)` for profile post listing.

### `V3__create_comments_and_tags.sql` — adds `comment_count`, `post_tags`, `comments`

- `posts.comment_count INTEGER` — denormalized counter.
- `post_tags (post_id, tag)` — composite PK, `tag ~ '^[a-z0-9_]{1,50}$'`, indexed on `tag` for hashtag lookup.
- `comments (id, post_id, user_id, text VARCHAR(300), created_at, updated_at, deleted_at)` — indexed on `(post_id, created_at DESC)`.

### `V4__create_post_likes.sql` — adds `like_count`, `post_likes`

- `posts.like_count INTEGER` — denormalized counter.
- `post_likes (post_id, user_id, created_at)` — composite PK `(post_id, user_id)`, indexed on `user_id` for "which of these posts has this user liked" batch lookups during feed/profile hydration.

> **Note:** a DynamoDB `likes` table also exists (`EscldLikesStack`, single-table adjacency-list design — see below). Confirm against the backend's actual `LikeStore` implementation which of the two is the live source of truth for the like *relationship* before relying on this in code — this Postgres table may be the pre-migration implementation kept for the denormalized `like_count` column specifically, with `post_likes` itself superseded.

### `V5`–`V7` — live streaming fields

- `users.stream_key` stores the rotated RTMP publishing key.
- Posts gain the `LIVE` media type plus live status/timestamps and a partial uniqueness constraint allowing one active stream per user.
- `posts.peak_viewer_count` stores the highest heartbeat-derived viewer estimate for an ended stream.

### `V8__create_warehouse_outbox.sql` — `warehouse_outbox`

One immutable row per accepted warehouse event. Relational mutations and their outbox event commit in the same Postgres transaction. The Kafka relay leases pending rows with `FOR UPDATE SKIP LOCKED`, publishes a stable event ID, and marks the row sent only after broker acknowledgment. Expired leases are recoverable after process failure and acknowledged rows are retained for seven days by default.

The table stores the v2 event metadata, JSON payload, availability/lease state, attempt count, acknowledgment time, and last error. Its partial pending index supports the relay without scanning acknowledged history.

The DynamoDB `domain_outbox` table provides the equivalent atomic boundary for like and follow mutations. Each edge transaction includes one stable event record; the `byPendingTime` GSI spreads due work over 16 deterministic shards, relay claims use expiring leases, and acknowledged rows leave the pending index before TTL cleanup.

## DynamoDB tables

All six use `PAY_PER_REQUEST` billing (no provisioned-capacity planning needed) with point-in-time recovery enabled. Every one is an **adjacency-list** or **single-table** design — one table, generic `pk`/`sk` string keys, multiple logical entity types distinguished by key prefix, chosen so the most common query for that entity is always a single-partition read.

### `follows` (`EscldSocialGraphStack`)

One item per follow edge, written under **both** users' partitions so both directions are a single-partition query:

```
pk = USER#<id>, sk = FOLLOWER#<followerId>   -> "who follows <id>"
pk = USER#<id>, sk = FOLLOWING#<followeeId>  -> "who does <id> follow"
```

### `feed` (`EscldFeedStack`)

Fan-out-on-write: one item per (recipient, post) pair, written by `feed-worker` when a post is created.

```
pk = USER#<recipientId>, sk = POST#<createdAt>#<postId>
```

### `conversations` (`EscldConversationsStack`)

Backs ws-sfu's messaging feature:

```
pk = CONVO#<id>,     sk = META                        -> conversation metadata
pk = CONVO#<id>,     sk = MSG#<createdAt>#<msgId>      -> one item per message
pk = USER#<id>,      sk = CONVO#<lastMsgAt>#<convoId>  -> per-user inbox, fanned out on send
pk = DMPAIR#<a>#<b>, sk = META                         -> DM dedup (two users only ever get one thread)
```

### `moderation` (`EscldModerationStack`)

Reports + moderator audit log. The one DynamoDB table with `RemovalPolicy.RETAIN`.

```
pk = REPORT#<id>,       sk = META                    -> canonical report record
pk = MODQUEUE#OPEN,     sk = REPORT#<createdAt>#<id>  -> open-report queue, item deleted on resolve
pk = MOD#<moderatorId>, sk = ACTION#<createdAt>#<id>  -> per-moderator audit trail
```

`MODQUEUE#OPEN` is a single hot partition for the entire platform's open-report queue — a known, flagged risk if report volume ever grows large (see `INFRASTRUCTURE.md`'s roadmap notes / the project's ADR history).

### `likes` (`EscldLikesStack`)

```
pk = POST#<id>, sk = LIKE#<likerId>    -> "does <likerId> like <id>"
pk = USER#<id>, sk = LIKED#<postId>    -> "which posts has <id> liked" (+ a byUserRecency GSI for feed-ranking's "recently liked" query)
```

The like *count* is not stored here — it stays a denormalized counter on the Postgres `posts.like_count` column.

### `post_hides` (`EscldPostHidesStack`)

```
pk = USER#<id>, sk = HIDDEN#<postId>   -> "has <id> hidden <postId>"
```

The feed's first real negative signal (see `FeedServiceImpl`'s own doc comment on why every other signal is purely positive/absent) — a hidden post is excluded from that viewer's own feed candidates entirely, not merely ranked lower. Single-partition-per-user with no reverse edge under the post's own partition: nothing in this app ever needs "who hid this post," only "has this viewer hidden this post." Hide and unhide write `post.hidden`/`post.unhidden` events to `domain_outbox` in the same DynamoDB transaction. Account deletion removes these records without emitting preference-reversal events.

## Elasticsearch

Index `posts_search` (name configurable via `POSTS_SEARCH_INDEX`), populated by `feed-worker` on every `post_created` event: post text, tags, author, timestamp, and a 384-dimension embedding vector (see `docs/BACKGROUND_SERVICES.md`) for semantic/hybrid search. Self-hosted, not managed OpenSearch — see `docs/INFRASTRUCTURE.md` for why.

## Redis

Not a system of record — one shared ElastiCache cluster (see `docs/INFRASTRUCTURE.md`'s `CacheStack`), three uses:

1. **Backend rate limiting** — Bucket4j token buckets, one per client IP, stored in Redis so rate limits are correctly shared across every backend replica (not per-instance).
2. **Analytics trending** — one Redis sorted set per entity type (`trending:posts`, `trending:hashtags`), scored by weighted engagement events and periodically decayed. See `docs/BACKGROUND_SERVICES.md`.
3. **Feed ranking** — `backend`'s `FeedServiceImpl` reads `trending:posts` directly (via `TrendingScoreClient`, `backend/src/main/java/com/escld/backend/trending/`) to fold analytics' live engagement-momentum score into the ranked feed's relevance blend, alongside semantic affinity and all-time engagement. This makes `trending:posts`'s key/member/score shape (owned by `analytics/src/trending.ts`) a genuine cross-service, cross-language contract — change its shape on the writer side and the Java reader breaks silently, not at compile time. The read is best-effort: a Redis failure here degrades feed ranking back to its pre-trending behavior rather than failing the request.
