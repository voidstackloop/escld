use uuid::Uuid;

/// Reads the peak concurrent-viewer count the Java backend's
/// `LiveViewerPresenceServiceImpl` has been maintaining in Redis for this
/// post (`live:viewers:peak:<postId>`, a plain string-encoded integer — see
/// that class's own doc for the full key scheme). Read-only: this server
/// never writes to that key itself, only the app's heartbeat endpoint does.
///
/// This exists specifically for the crash/disconnect path
/// (`rtmp.rs::handle_connection`'s finalize block): when a stream ends via
/// the app's own "End Stream" button, `LiveStreamServiceImpl.end()` already
/// reads this same key and persists it — but when an encoder just
/// disconnects (crash, network drop) with nobody clicking anything, this
/// server's own `mark_live_ended` is the only code that ever runs, so it has
/// to do this same read itself or `peak_viewer_count` stays null forever for
/// every stream that ends this way.
///
/// Best-effort like every other cross-service reach in this app: no Redis
/// configured, a connection failure, or a missing/unparseable key all
/// resolve to `None` (leaving the column null) rather than failing the
/// disconnect-handling path a stream's actual end depends on.
pub async fn peak_viewer_count(redis_host: &str, redis_port: u16, post_id: Uuid) -> Option<i32> {
    use redis::AsyncCommands;

    let url = format!("redis://{redis_host}:{redis_port}");
    let result: anyhow::Result<Option<i32>> = async {
        let client = redis::Client::open(url)?;
        let mut conn = client.get_multiplexed_async_connection().await?;
        let value: Option<String> = conn.get(format!("live:viewers:peak:{post_id}")).await?;
        Ok(value.and_then(|v| v.parse().ok()))
    }
    .await;

    match result {
        Ok(count) => count,
        Err(err) => {
            tracing::warn!(error = %err, post_id = %post_id, "failed to read peak viewer count from Redis");
            None
        }
    }
}
