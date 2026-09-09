use std::path::PathBuf;

use axum::Router;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

/// `/health` (matches every other service in this app) plus a static mount
/// of the live HLS output directory — this pass has no S3/CloudFront upload
/// (see the plan doc's own Phase 2 note), so this is the only way anything
/// can actually watch a stream, local testing included. CORS wide open:
/// there's no per-viewer auth model for HLS playback in this pass either
/// (a live stream's playlist URL is not treated as a secret the way the
/// *publish* stream key is), so restricting origins here would only block
/// legitimate playback for no real security benefit.
pub async fn serve(port: u16, hls_dir: PathBuf) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/health", get(health))
        .nest_service("/hls", ServeDir::new(hls_dir))
        .layer(CorsLayer::permissive());

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!(port, "rtmp http server listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}
