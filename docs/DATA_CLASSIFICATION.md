# Data Classification

What's PII/sensitive across escld's stores, and at what sensitivity — grounded in the actual schemas in `docs/DATA_MODEL.md`, not a generic policy template. Three tiers, used consistently below:

- **Direct PII** — identifies a specific person on its own (email, birthdate).
- **Indirect/behavioral PII** — identifies a person only combined with other data, or reveals behavior/preferences about them (posts, likes, follow graph, messages).
- **Not PII** — operational/derived data with no direct link to an individual's identity or behavior (aggregate counts, trending scores).

## Postgres (`backend/src/main/resources/db/migration/`)

| Table.Column | Tier | Notes |
|---|---|---|
| `users.email` | Direct PII | Unique, `CITEXT`. Auth itself lives in Cognito — this is a synced profile copy. |
| `users.birthdate` | Direct PII | Nullable. |
| `users.username`, `display_name`, `bio`, `location`, `website_url` | Indirect PII | User-supplied, often but not always identifying. |
| `users.avatar_url`, `cover_image_url` | Indirect PII | CloudFront URLs pointing at S3-stored images of/chosen by the user. |
| `users.cognito_sub` | Direct PII (identifier) | Links this row to a specific Cognito identity — treat like an ID, not a public field. |
| `posts.text`, `comments.text`, `post_tags.tag` | Indirect PII | User-generated content; behavioral/expressive data about the author. |
| `post_likes`, `posts.like_count`, `posts.comment_count`, `users.followers_count/following_count/posts_count` | Not PII on their own (aggregate counters) | `post_likes` rows themselves (`post_id, user_id`) are Indirect PII — a specific user's specific engagement. |

## DynamoDB (five tables, see `DATA_MODEL.md`)

| Table | Tier | Notes |
|---|---|---|
| `follows` | Indirect PII | The social graph itself — who follows whom is behavioral data. |
| `feed` | Indirect PII | Derived from `follows`/`posts`, same sensitivity. |
| `conversations` | **Direct PII (highest sensitivity in the system)** | `MSG#` items hold actual private-message content between two named users — the most sensitive data this app stores. |
| `moderation` | Direct PII, restricted-access by design | Reports and moderator actions name both the reporter/subject and the acting moderator. Already the one table with `RemovalPolicy.RETAIN` — correctly excluded from any future TTL/retention automation (see below). |
| `likes` | Indirect PII | Same sensitivity as Postgres `post_likes` — this is believed to be the live source of truth for the like relationship (see `DATA_MODEL.md`'s note). |
| `post_hides` | Indirect PII | A viewer's own "not interested" decisions — arguably more sensitive than a like in one respect (it reveals content someone actively didn't want to see), though still purely behavioral, not identity data. |

## Elasticsearch (`posts_search`)

Indirect PII — post text, tags, author, and a 384-dim embedding vector are all derived from `posts`/Postgres and carry the same sensitivity as the source.

## S3

Direct/Indirect PII — uploaded avatar/cover images and transcoded post video/audio are user-identifying media. Access is via CloudFront URLs, not public bucket listing.

## BigQuery (`escld_events_raw` dataset, see the analytics-pipeline plan)

Indirect PII — every raw landing table (`raw_post_created`, `raw_post_liked`, `raw_post_commented`, `raw_user_followed`, `raw_user_unfollowed`) carries `authorId`/`userId`/`followerId`/`followeeId` fields, i.e. behavioral event data tied to a specific user ID (not raw email/profile fields — those never flow into this pipeline). This is the one store outside AWS's own account boundary, so it's worth flagging distinctly: it lives in GCP, reachable only via the narrowly-scoped `bq-sink` service account (BigQuery Data Editor on this dataset only, not project-wide — see `bq-sink/setup-gcp.sh`).

## Redis

Not PII — rate-limit token-bucket state is keyed by client IP (not stored long-term, TTL'd by Bucket4j itself), and trending sorted sets hold post/hashtag IDs with aggregate scores, not per-user data.

## What this classification is for right now

This document exists to make the GDPR account-deletion capability's scope explicit (which stores a deletion/anonymization must actually touch — Postgres, the DynamoDB tables above except the audit-trail portion of `moderation`, Elasticsearch, and S3) and to flag `conversations` and `moderation` as the two stores needing the most caution in any future data-access or export tooling. It is not itself a retention policy — retention periods are a product/legal decision, tracked separately (see the GDPR deletion capability's own scoping note in the enterprise-hardening plan).
