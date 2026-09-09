# Backend (Spring Boot API)

Java 25, Spring Boot 4.0.5, Maven. Located at `backend/`. This is the core REST API — posts, comments, likes, follows, moderation, search, media — everything except real-time calling/messaging (`ws-sfu`), transcoding (`worker`), feed fan-out (`feed-worker`), and trending (`analytics`), which are separate services (see `docs/WS_SFU.md` and `docs/BACKGROUND_SERVICES.md`).

## Package structure

| Package | Responsibility |
|---|---|
| `controllers` | All 10 REST controllers — the entire HTTP API surface. |
| `services` / `services.impl` | One interface + implementation per domain area. Controllers depend only on interfaces. |
| `entities` | JPA entities: `User`, `Post`, `Comment`, `PostLike`/`PostLikeId`. |
| `repo` | Spring Data JPA repositories. |
| `dto`, `mappers`, `exceptions` | Request/response records, entity→DTO mapping, domain exceptions + the global error handler. |
| `config` | Security, CORS, rate limiting, caching, AWS clients, request logging. |
| `follow`, `like`, `moderation`, `feed` | DynamoDB-backed stores (raw AWS SDK v2, not Spring Data DynamoDB) — see `docs/DATA_MODEL.md`. |
| `transcode` | `TranscodeJobPublisher` — hands video/audio to the external `worker` service via SQS. |
| `analytics` | `AnalyticsEventPublisher` — Redis pub/sub engagement events, consumed by the external `analytics` service. |
| `search` | Elasticsearch documents/repositories for user search + post semantic search. |

A `graphqlcodegen-maven-plugin` entry exists in `pom.xml` but points at a schema directory that doesn't exist and nothing references generated code from it — unused scaffolding, not an active integration.

## REST API reference

Every endpoint requires a valid Cognito JWT (`SecurityConfig` sets `anyRequest().authenticated()` globally) except `OPTIONS /**` and `/actuator/**`. Endpoints marked **ADMIN/MODERATOR** additionally require the `admin` or `moderator` Cognito group via `@PreAuthorize("hasAnyRole('ADMIN','MODERATOR')")`.

### Posts — `PostController` (`/api/v1`)
| Method & Path | Description |
|---|---|
| `POST /posts` | Create a post (text and/or media). |
| `GET /posts/{id}` | Get a post; enforces private-account visibility. |
| `GET /users/{username}/posts` | Keyset-paginated list of a user's posts. |
| `DELETE /posts/{id}` | Soft-delete own post (owner only). |

### Comments — `CommentController` (`/api/v1`)
| Method & Path | Description |
|---|---|
| `POST /posts/{postId}/comments` | Add a comment. |
| `GET /posts/{postId}/comments` | List comments (batch-fetches authors). |
| `DELETE /comments/{id}` | Soft-delete own comment (owner only). |

### Likes — `LikeController` (`/api/v1`)
| Method & Path | Description |
|---|---|
| `POST /posts/{postId}/like` | Like a post (idempotent). |
| `DELETE /posts/{postId}/like` | Unlike a post (idempotent). |

### Feed — `FeedController` (`/api/v1`)
| Method & Path | Description |
|---|---|
| `GET /feed` | Ranked, paginated home feed — blends semantic similarity, engagement, recency, and author diversity. |

### Follows — `FollowController` (`/api/v1/users`)
| Method & Path | Description |
|---|---|
| `POST /{username}/follow` | Follow a user (`FOLLOWING`, or `PENDING` if the target is private). |
| `DELETE /{username}/follow` | Unfollow / cancel a pending request. |
| `GET /{username}/follow-status` | Current follow state relative to the caller. |
| `GET /{username}/followers` | List followers (403 if target is private and caller doesn't follow them). |
| `GET /{username}/following` | List who the target follows (same visibility rule). |

### Follow requests — `FollowRequestController` (`/api/v1/follow-requests`)
| Method & Path | Description |
|---|---|
| `GET /follow-requests` | Pending requests directed at the caller. |
| `POST /follow-requests/{username}/accept` | Accept a pending request. |
| `POST /follow-requests/{username}/reject` | Reject a pending request. |

### Users — `UserController` (`/api/v1/users`)
| Method & Path | Description |
|---|---|
| `GET /me` | Full profile of the caller (includes email/status). |
| `PATCH /me` | Partial profile update. |
| `GET /{username}` | Public profile (no email/status). |
| `POST /{id}/activate` | Set status to `ACTIVE`. Requires ADMIN/MODERATOR. |
| `POST /{id}/suspend` | Set status to `SUSPENDED`. Requires ADMIN/MODERATOR. |
| `POST /{id}/deactivate` | Set status to `DEACTIVATED`. Requires ADMIN/MODERATOR. |

All three carry `@PreAuthorize("hasAnyRole('ADMIN', 'MODERATOR')")` and log a `MOD#`-scoped audit entry via `ModerationStore.logAction`, same as `ModerationController`'s own actions below — they remain functionally redundant with `/moderation/users/{username}/suspend`/`reinstate` (likely legacy surface kept for compatibility), but are no longer unprotected.

### Moderation — `ModerationController` (`/api/v1/moderation`)
Reporting is open to any authenticated user; the queue and every action below require ADMIN/MODERATOR.
| Method & Path | Description | Auth |
|---|---|---|
| `POST /reports` | File a report against a post/comment/user. | Authenticated |
| `GET /reports` | List open reports. | ADMIN/MODERATOR |
| `POST /reports/{reportId}/resolve` | Resolve a report (optional note). | ADMIN/MODERATOR |
| `POST /users/{username}/suspend` | Suspend a user (audit-logged). | ADMIN/MODERATOR |
| `POST /users/{username}/reinstate` | Reinstate a suspended user (audit-logged). | ADMIN/MODERATOR |
| `POST /posts/{postId}/remove` | Remove a post (audit-logged). | ADMIN/MODERATOR |
| `POST /comments/{commentId}/remove` | Remove a comment (audit-logged). | ADMIN/MODERATOR |

### Search — `SearchController` (`/api/v1/search`)
| Method & Path | Description |
|---|---|
| `GET /users?q=` | Search users by username/display name (Elasticsearch, excludes private accounts). |

### Media — `MediaController` (`/api/v1/media`)
| Method & Path | Description |
|---|---|
| `POST /presigned-upload` | Issue a presigned S3 PUT URL for avatar/cover/post media, validated by `UploadPurpose`. The backend never streams media bytes itself. |

**10 controllers, 30 endpoints total.**

## Domain model

See `docs/DATA_MODEL.md` for full schema. Summary of what lives where:

- **JPA entities (Postgres)**: `User`, `Post`, `Comment`. Deliberately **no JPA object-graph relations** between them — `Post.userId`/`Comment.userId` are plain UUID foreign keys resolved by explicit queries in service code, avoiding N+1/lazy-loading traps. Follows are not modeled in JPA at all; they live entirely in DynamoDB.
- **`PostLike`/`PostLikeId` entity — dead code.** The entity, its repository, and the `post_likes` table still exist (Flyway creates it, Hibernate validates against it at startup), but nothing in `services`/`controllers` references them. The actual like store is DynamoDB's `LikeStore`; a companion script (`bin/dynamodb/backfill_likes.py`) confirms likes were migrated off Postgres. This looks like an un-cleaned-up leftover from that migration.
- **DynamoDB stores** (direct `DynamoDbClient` calls via `config/DynamoDbConfig`, not Spring Data DynamoDB): `FollowGraphStore`, `LikeStore`, `ModerationStore`, `FeedStore` — see `docs/DATA_MODEL.md` for their key shapes.
- **Elasticsearch documents**: `UserSearchDocument` (`user_search` index, kept in sync by `UserSearchIndexer` on every profile write) and `PostSearchDocument` (`posts_search` index, written by the external `feed-worker` — the backend only reads it, for `FeedServiceImpl`'s semantic ranking). Both indices use `createIndex = false` — creation is manual via `bin/elasticsearch/*.sh`, deliberately, to dodge a Spring Boot 4 / ES client response-parsing issue.

## Security

- **`SecurityConfig`**: stateless sessions, CSRF disabled (pure JWT bearer API), OAuth2 resource server with a custom `JwtDecoder` + `JwtAuthenticationConverter`.
- **JWT validation**: `JwtDecoders.fromIssuerLocation(issuerUri)` auto-discovers Cognito's JWKS. Validator chain = the default issuer validator **plus** `CognitoAccessTokenValidator`, which closes a real gap — Cognito access tokens carry no `aud` claim — by rejecting any token where `token_use != "access"` (blocking ID tokens from being used as bearer tokens) or whose `client_id` claim doesn't match the configured app client.
- **Roles**: `CognitoGroupsConverter` maps each `cognito:groups` entry to `ROLE_<GROUP_UPPERCASE>` (`admin` → `ROLE_ADMIN`, `moderator` → `ROLE_MODERATOR`); every authenticated request also gets `ROLE_USER` unconditionally. No local roles table — Cognito User Pool Groups (provisioned in `frontend/amplify/auth/resource.ts`) are the sole source of truth.
- **CORS**: origins from `app.cors.allowed-origins` (env `CORS_ALLOWED_ORIGINS`), methods `GET/POST/PUT/PATCH/DELETE/OPTIONS`, headers `Authorization`/`Content-Type`, credentials allowed.
- **Actuator isolation**: `management.server.port` (default `9090`) is a separate port from the public API (`server.port`, default `8080`) and is *not* covered by the JWT filter chain at all — network isolation (keeping it off any public load balancer) is the real security boundary, not auth.

## Rate limiting

Bucket4j (`bucket4j_jdk17-lettuce`) backed by a dedicated Lettuce connection to Redis (separate from the Spring Data Redis connection used for caching), via `LettuceBasedProxyManager` — one token bucket per client IP, shared across every backend replica so limits hold under horizontal scaling.

- Capacity `app.rate-limit.capacity` (default 100), refilling `app.rate-limit.refill-tokens` (default 100) every `app.rate-limit.refill-duration` (default `1m`).
- Keyed by `X-Forwarded-For` (first hop) or `request.getRemoteAddr()`, prefixed `rate-limit:`.
- Registered as a servlet filter at `Ordered.HIGHEST_PRECEDENCE` on `/api/*`, ahead of Spring Security — a throttled request never pays JWT-validation cost.
- On throttle: `429` with `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`Retry-After` headers.
- Toggle: `app.rate-limit.enabled` (default `true`) — the whole config bean is conditional on this flag.

## Integration points with other services

The backend never handles WebSockets itself — real-time calling/messaging is entirely `ws-sfu`'s job. Everything else is fire-and-forget, best-effort (wrapped in try/catch, log-only-on-failure, never fails the parent request):

| Publisher | Transport | Consumed by | Trigger |
|---|---|---|---|
| `TranscodeJobPublisher` | SQS (`app.sqs.transcode-queue-url`) | `worker` | Post created with `VIDEO`/`AUDIO` media — post is saved `mediaStatus=PROCESSING` first. |
| `PostEventPublisher` | SQS (`app.sqs.post-events-queue-url`) | `feed-worker` | Every post creation — triggers embedding, ES indexing, and feed fan-out. |
| `AnalyticsEventPublisher` | Redis pub/sub (`app.analytics.events-channel`) | `analytics` | `post_created`/`post_liked`/`post_commented` — reuses the existing Redis connection, no delivery guarantee needed. |

## Error handling

Centralized in `GlobalExceptionHandler` (`@RestControllerAdvice`), uniform response body:

```json
{ "timestamp": "...", "status": 404, "error": "...", "message": "...", "path": "...", "fieldErrors": {} }
```

One handler per domain exception (`UserNotFoundException` → 404, `UsernameAlreadyTakenException` → 409, `UnsupportedMediaTypeException` → 415, `SelfFollowException`/`InvalidPostException` → 400, `PrivateAccountException`/`NotPostOwnerException`/`NotCommentOwnerException` → 403), `MethodArgumentNotValidException` → 400 with a per-field `fieldErrors` map, and an `Exception` catch-all → 500 (logged).

## Database migrations

Flyway, but run manually via a custom `FlywayMigrationListener` (not Spring Boot's Flyway autoconfiguration, which a code comment says isn't on the classpath for this Boot version) — it migrates before the `ApplicationContext` refreshes, so Hibernate's `ddl-auto: validate` check always sees the final schema. See `docs/DATA_MODEL.md` for the schema itself; migrations live at `backend/src/main/resources/db/migration/V1`–`V4`.

## Testing

JUnit 5 + Mockito + AssertJ. Modest coverage (5 test classes) concentrated on the trickiest business logic:

- **Unit tests** (mocked dependencies): `FeedServiceImplTest` (pins down the ranking algorithm), `FollowServiceImplTest`, `LikeServiceImplTest`, `ModerationServiceImplTest`.
- **Integration test**: `PostServiceImplIntegrationTest` — `@DataJpaTest` + Testcontainers with a real Postgres container and real Flyway migrations. Explicitly a regression test for a real data-loss bug found in dev (a bulk JPA update with `clearAutomatically=true` discarding an unflushed insert).

No controller-layer (`@WebMvcTest`) or security-layer tests currently exist.

## Key configuration (`application.yml`)

Single file, no profile variants — fully env-var parameterized. No secrets are hardcoded for real use; defaults are dev-only fallbacks.

| Area | Setting | Default |
|---|---|---|
| Hikari pool | `DB_POOL_MAX_SIZE` / `DB_POOL_MIN_IDLE` | 10 / 2 |
| Cache | Redis, 30s TTL on `usersById`/`usersByUsername`/`usersByCognitoSub` | — |
| Actuator | `MANAGEMENT_PORT` | 9090 |
| Logging | `LOG_LEVEL_ROOT` / `LOG_LEVEL_APP` / `LOG_FORMAT` (`ecs`/`logstash` for JSON) | INFO / DEBUG / plain text |
| `app.cors.allowed-origins` | `CORS_ALLOWED_ORIGINS` | `http://localhost:5173` |
| `app.cognito.issuer-uri` / `app-client-id` | — | eu-central-1 user pool |
| `app.media.*` | bucket/region/CloudFront domain/presign expiry | 15 min presign expiry |
| `app.dynamodb.*` | region/endpoint + table names | `follows`/`feed`/`moderation`/`likes` |
| `app.sqs.*` | endpoint + the two queue URLs | — |
| `app.analytics.events-channel` | — | `analytics-events` |
| `app.rate-limit.*` | enabled/capacity/refill-tokens/refill-duration | true / 100 / 100 / 1m |
