use std::sync::Arc;

use rtmp::config::Config;
use rtmp::rtmp::rtmp::process;
use rtmp::warehouse::WarehouseEventPublisher;
use rtmp::{http, store};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // JSON structured logging is opt-in (LOG_FORMAT=json), matching every
    // other Rust service in this app (see ws-sfu/src/main.rs) — plain text
    // stays the default for local dev.
    if std::env::var("LOG_FORMAT").as_deref() == Ok("json") {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
            .init();
    }

    let config = Arc::new(Config::from_env()?);
    let pool = store::postgres::connect(&config).await?;

    // Built unconditionally (same as ws-sfu's own S3 client) — cheap, and
    // keeps the graceful-degradation check (config.live_bucket.is_none())
    // in one place (s3_sync's own call site) rather than threading an
    // Option<Client> through every layer between here and there.
    let aws_shared_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let s3 = Arc::new(aws_sdk_s3::Client::new(&aws_shared_config));

    // Built once at startup (resolving MSK's bootstrap brokers is itself a
    // real AWS API call — not worth repeating per connection), entirely
    // inert when no MSK cluster is configured (config.kafka_cluster_arn is
    // None) — see WarehouseEventPublisher::new's own doc.
    let warehouse = Arc::new(
        WarehouseEventPublisher::new(
            config.kafka_cluster_arn.as_deref(),
            &config.kafka_region,
            config.kafka_local_bootstrap_servers.as_deref(),
        )
        .await,
    );

    let http_config = Arc::clone(&config);
    tokio::spawn(async move {
        if let Err(err) = http::serve(4001, http_config.hls_dir.clone().into()).await {
            tracing::error!(error = %err, "rtmp http server failed");
        }
    });

    let listener = TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!(port = config.port, "rtmp server listening");

    loop {
        let (socket, addr) = listener.accept().await?;
        tracing::info!(peer = %addr, "accepted rtmp connection");
        let pool = pool.clone();
        let config = Arc::clone(&config);
        let s3 = Arc::clone(&s3);
        let warehouse = Arc::clone(&warehouse);
        tokio::spawn(async move {
            process(socket, pool, config, s3, warehouse).await;
        });
    }
}
