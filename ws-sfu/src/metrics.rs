use std::sync::LazyLock;

use axum::http::header;
use axum::response::IntoResponse;
use prometheus::{Encoder, IntCounter, IntGauge, Registry, TextEncoder};

static REGISTRY: LazyLock<Registry> = LazyLock::new(Registry::new);

fn gauge(name: &str, help: &str) -> IntGauge {
    let g = IntGauge::new(name, help).expect("valid metric name");
    REGISTRY.register(Box::new(g.clone())).expect("metric registered once");
    g
}

fn counter(name: &str, help: &str) -> IntCounter {
    let c = IntCounter::new(name, help).expect("valid metric name");
    REGISTRY.register(Box::new(c.clone())).expect("metric registered once");
    c
}

pub static SOCKETS_CONNECTED: LazyLock<IntGauge> =
    LazyLock::new(|| gauge("ws_sfu_sockets_connected", "Currently connected Socket.IO sockets"));

pub static ROOMS_ACTIVE: LazyLock<IntGauge> =
    LazyLock::new(|| gauge("ws_sfu_call_rooms_active", "Currently active mediasoup call rooms"));

pub static MESSAGES_SENT_TOTAL: LazyLock<IntCounter> =
    LazyLock::new(|| counter("ws_sfu_messages_sent_total", "Chat messages successfully sent"));

pub static CALL_PRODUCERS_TOTAL: LazyLock<IntCounter> = LazyLock::new(|| {
    counter("ws_sfu_call_producers_total", "mediasoup producers created (mic/camera/screen)")
});

pub static AUTH_FAILURES_TOTAL: LazyLock<IntCounter> =
    LazyLock::new(|| counter("ws_sfu_auth_failures_total", "Rejected connect attempts (bad/expired token)"));

/// `GET /metrics` - unauthenticated, matches the backend's `/actuator/prometheus`
/// convention (see config/prometheus.yml). Wire a scrape job at `ws-sfu:4000/metrics`
/// there to pick this up.
pub async fn handler() -> impl IntoResponse {
    let metric_families = REGISTRY.gather();
    let mut buffer = Vec::new();
    TextEncoder::new()
        .encode(&metric_families, &mut buffer)
        .expect("encoding registered metrics never fails");

    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], buffer)
}
