mod auth;
mod config;
mod emf;
mod health;
mod kafka;
mod metrics;
mod rate_limit;
mod sfu;
mod state;
mod store;
mod types;
mod ws;

use std::sync::Arc;

use axum::Router;
use axum::routing::get;
use opentelemetry::KeyValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::SdkTracerProvider;
use socketioxide::SocketIo;
use socketioxide::handler::ConnectHandler;
use tower_http::cors::CorsLayer;
use tracing_subscriber::Layer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use auth::CognitoVerifier;
use config::Config;
use sfu::RoomRegistry;
use state::AppState;
use store::dynamo::ConversationsRepo;
use store::social_graph::FollowGraphRepo;

/// X-Ray tracing, Phase 2 of the telemetry rollout — see Cargo.toml's
/// comment on the opentelemetry* dependencies for why this is hand-rolled
/// rather than an auto-instrumentation agent like the Java/Node services
/// use. Opt-in via OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (unset = no tracer,
/// same graceful-degradation shape as the Java backend's
/// app.kafka.enabled) so local dev — no ADOT Collector sidecar running —
/// never fails to start over this. Returns the provider so its background
/// exporter thread stays alive for the process lifetime (dropping it would
/// stop span export).
fn init_tracer_provider() -> anyhow::Result<Option<SdkTracerProvider>> {
    let Ok(endpoint) = std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") else {
        return Ok(None);
    };

    let exporter = SpanExporter::builder()
        .with_http()
        .with_endpoint(endpoint)
        .with_protocol(Protocol::HttpBinary)
        .build()?;

    let service_name = std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| "escld-ws-sfu".to_string());
    let resource = Resource::builder()
        .with_attribute(KeyValue::new("service.name", service_name))
        .build();

    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(resource)
        .build();
    opentelemetry::global::set_tracer_provider(provider.clone());
    Ok(Some(provider))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let tracer_provider = init_tracer_provider()?;

    // JSON structured logging is opt-in (LOG_FORMAT=json), matching the
    // backend's LOG_FORMAT=ecs pattern — plain text stays the default for
    // local dev, where it's easier to read at a glance. Restructured onto
    // tracing_subscriber's layered Registry (rather than the old
    // tracing_subscriber::fmt() shortcut builder) so the optional
    // tracing-opentelemetry layer above can be composed alongside it —
    // fmt() alone has no way to add a second layer.
    let json_logs = std::env::var("LOG_FORMAT").as_deref() == Ok("json");
    let fmt_layer: Box<dyn Layer<tracing_subscriber::Registry> + Send + Sync> = if json_logs {
        Box::new(tracing_subscriber::fmt::layer().json())
    } else {
        Box::new(tracing_subscriber::fmt::layer())
    };

    // EnvFilter lives inside the same Vec as the other layers, rather than
    // behind its own separate `.with()` call, so every boxed layer here is
    // typed against the same base `Layer<Registry>` — chaining a second
    // `.with()` on top would change the subscriber's concrete type to
    // `Layered<EnvFilter, Registry>`, which this Vec's trait objects
    // (erased to plain `Registry`) can no longer satisfy.
    let mut layers: Vec<Box<dyn Layer<tracing_subscriber::Registry> + Send + Sync>> =
        vec![Box::new(tracing_subscriber::EnvFilter::from_default_env()), fmt_layer];
    if let Some(provider) = &tracer_provider {
        let tracer = provider.tracer("ws-sfu");
        layers.push(Box::new(tracing_opentelemetry::layer().with_tracer(tracer)));
    }

    tracing_subscriber::registry().with(layers).init();

    let config = Arc::new(Config::from_env()?);
    let port = config.port;

    let cors_origins: Vec<axum::http::HeaderValue> = config
        .cors_allowed_origins
        .iter()
        .filter_map(|origin| origin.parse().ok())
        .collect();

    let cognito = Arc::new(CognitoVerifier::new(
        config.cognito_issuer_uri.clone(),
        config.cognito_app_client_id.clone(),
    ));
    if let Err(err) = cognito.refresh_jwks().await {
        tracing::warn!(error = %err, "initial JWKS fetch failed, will retry on first request");
    }
    cognito.spawn_periodic_refresh();

    let pg = store::postgres::connect(&config).await?;
    let dynamo = ConversationsRepo::new(&config).await?;
    let follow_graph = FollowGraphRepo::new(&config).await?;

    tracing::info!(count = config.mediasoup_worker_count, "starting mediasoup workers");
    let sfu = RoomRegistry::new(Arc::clone(&config)).await?;

    let aws_shared_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let s3 = aws_sdk_s3::Client::new(&aws_shared_config);

    let state = AppState::new(cognito, pg, dynamo, sfu, s3, Arc::clone(&config), follow_graph);

    let (layer, io) = SocketIo::builder().with_state(state.clone()).build_layer();
    io.ns("/", ws::on_connect.with(ws::authenticate));

    // Inert when no MSK cluster is configured (see Config::kafka_cluster_arn's
    // own doc) — same graceful-degradation shape as every other optional
    // integration in this app.
    tokio::spawn(kafka::spawn(io.clone(), state.clone()));

    let cors = CorsLayer::new()
        .allow_origin(cors_origins)
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    let app = Router::new()
        .route("/health", get(health::health))
        .route("/metrics", get(metrics::handler))
        .layer(layer)
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!(port, "ws-sfu listening");
    axum::serve(listener, app).await?;

    Ok(())
}
