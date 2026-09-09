use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use uuid::Uuid;

use crate::config::Config;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub username: String,
}

/// Mirrors ws-sfu/src/store/postgres.rs's `connect()` exactly — same pool
/// sizing, same connect-options shape.
pub async fn connect(config: &Config) -> anyhow::Result<PgPool> {
    let ssl_mode = if config.db_ssl {
        PgSslMode::Require
    } else {
        PgSslMode::Prefer
    };

    let opts = PgConnectOptions::new()
        .host(&config.db_host)
        .port(config.db_port)
        .database(&config.db_name)
        .username(&config.db_user)
        .password(&config.db_password)
        .ssl_mode(ssl_mode);

    let pool = PgPoolOptions::new().max_connections(5).connect_with(opts).await?;

    Ok(pool)
}

/// Resolves a stream key (the value an encoder like OBS sends as the publish
/// name, `rtmp://host/live/<streamKey>`) to the user who owns it. `None`
/// means an invalid, never-generated, or revoked (rotated away) key, or the
/// account was soft-deleted — the caller must refuse the publish in every
/// one of those cases, not just log a warning.
pub async fn find_by_stream_key(pool: &PgPool, stream_key: Uuid) -> anyhow::Result<Option<UserRow>> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username FROM users WHERE stream_key = $1 AND deleted_at IS NULL",
    )
    .bind(stream_key)
    .fetch_optional(pool)
    .await?;

    Ok(row)
}

/// Finds the Post id of the user's currently-announced live stream (see the
/// backend's `LiveStreamService` — a stream has to be announced with a
/// title/description via `POST /api/v1/live/streams` *before* the encoder
/// connects). `None` means the user has a valid stream key but never
/// announced anything — the caller must refuse the publish rather than
/// silently accepting a title-less stream, so a live post's title/
/// description are a real prerequisite, not an optional afterthought.
pub async fn find_live_post_id_for_user(pool: &PgPool, user_id: Uuid) -> anyhow::Result<Option<Uuid>> {
    let row: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM posts WHERE user_id = $1 AND live_status = 'LIVE' AND deleted_at IS NULL",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(id,)| id))
}

/// Enough of the just-ended stream's own record to publish a `live.ended`
/// warehouse event (see `warehouse::publish_live_ended`) — deliberately not
/// the whole `Post` row, just the two fields that event's payload needs
/// beyond `post_id`/`peak_viewer_count` (both already known to the caller).
pub struct EndedStreamInfo {
    pub author_id: Uuid,
    pub duration_seconds: i64,
}

/// Marks a live post ended the moment the RTMP connection itself drops —
/// this is the *only* thing this server does to end a stream automatically
/// (an encoder crash, a network drop, a deliberate disconnect all look the
/// same from here). Deliberately direct Postgres access, not a call back
/// into the backend: this keeps the "is this still live" flag honest in
/// near-real-time without needing an HTTP client/credential in this
/// service — same "Rust services own their own DB read" reasoning already
/// applied to `find_by_stream_key` above. `peak_viewer_count` is set in the
/// same statement as `live_ended_at` (mirrors the Java backend's own
/// `PostRepository.endLiveStream` — one round trip, not a second write);
/// `None` when no Redis peak-viewer tracking is configured (see
/// `warehouse::peak_viewer_count`), leaving the column null exactly like
/// any other live post that never had viewer tracking. `Ok(None)` (not an
/// error) means the row wasn't actually LIVE when this ran — a race between
/// this and the app's own explicit "End Stream" button, or a double-close
/// on this same connection; either way there's nothing further to do.
pub async fn mark_live_ended(
    pool: &PgPool,
    post_id: Uuid,
    peak_viewer_count: Option<i32>,
) -> anyhow::Result<Option<EndedStreamInfo>> {
    let row: Option<(Uuid, i64)> = sqlx::query_as(
        "UPDATE posts SET live_status = 'ENDED', live_ended_at = now(), peak_viewer_count = $2 \
         WHERE id = $1 AND live_status = 'LIVE' \
         RETURNING user_id, EXTRACT(EPOCH FROM (live_ended_at - live_started_at))::BIGINT",
    )
    .bind(post_id)
    .bind(peak_viewer_count)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(author_id, duration_seconds)| EndedStreamInfo { author_id, duration_seconds }))
}

/// Flips a live post's `media_status` from PROCESSING to READY once the
/// encoder has actually started publishing — the backend sets `mediaUrl` at
/// announce time already (it's deterministic from the stream key), but
/// leaves `mediaStatus` at PROCESSING until there's real HLS output behind
/// that URL, so the frontend's existing PROCESSING/READY branch (see
/// post-card.tsx's PostMedia) shows a "stream starting soon" placeholder
/// right up until this fires, then the real `<video>` element.
pub async fn mark_media_ready(pool: &PgPool, post_id: Uuid) -> anyhow::Result<()> {
    sqlx::query("UPDATE posts SET media_status = 'READY' WHERE id = $1 AND media_status = 'PROCESSING'")
        .bind(post_id)
        .execute(pool)
        .await?;
    Ok(())
}
