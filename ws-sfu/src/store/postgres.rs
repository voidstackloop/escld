use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use uuid::Uuid;

use crate::config::Config;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub username: String,
}

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

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;

    Ok(pool)
}

/// Resolves a Cognito `sub` to the canonical app-wide user id + username.
/// A `None` here means either the row genuinely doesn't exist yet (the
/// PostConfirmation Lambda logs-and-swallows DB failures, so this is a real,
/// legitimate race for a freshly-confirmed signup) or the account was soft
/// deleted - either way the caller should reject the connection.
pub async fn find_by_cognito_sub(
    pool: &PgPool,
    cognito_sub: Uuid,
) -> anyhow::Result<Option<UserRow>> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username FROM users WHERE cognito_sub = $1 AND deleted_at IS NULL",
    )
    .bind(cognito_sub)
    .fetch_optional(pool)
    .await?;

    Ok(row)
}

/// Resolves a user id to their username, for `kafka/mod.rs`'s live-started
/// push — the Kafka payload only carries `authorId`, not a username.
pub async fn find_username(pool: &PgPool, user_id: Uuid) -> anyhow::Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?;

    Ok(row.map(|(username,)| username))
}

/// Resolves whether a post is currently a live stream, returning its
/// author's user id if so — `ws/live.rs::join` uses this to refuse joining a
/// live-chat room for a post that isn't actually live, the same direct-
/// Postgres-read pattern `rtmp/src/store/postgres.rs::find_live_post_id_for_user`
/// already uses for the equivalent check on the publish side. `None` means
/// not live (never was, already ended, or doesn't exist) — every one of
/// those cases is refused identically, not distinguished for the caller.
pub async fn find_live_post_author(pool: &PgPool, post_id: Uuid) -> anyhow::Result<Option<Uuid>> {
    let row: Option<(Uuid,)> = sqlx::query_as(
        "SELECT user_id FROM posts WHERE id = $1 AND live_status = 'LIVE' AND deleted_at IS NULL",
    )
    .bind(post_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(user_id,)| user_id))
}
