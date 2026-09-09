//! Emits CloudWatch Embedded Metric Format JSON lines directly to stdout via
//! `println!`, bypassing the `tracing` subscriber entirely — mirrors how the
//! backend's Java client and the Node workers' EMF client work too, each
//! writing through their own dedicated sink rather than the app's normal
//! structured-logging pipeline. CloudWatch auto-extracts real metrics from
//! any EMF-shaped line found in a log group; on this service specifically,
//! that's the log group `WsSfuStack` wires the EC2 instance's
//! `docker run --log-driver awslogs` to ship into (see that stack's
//! `LogGroup`) — no separate scrape agent or collector needed.
//!
//! No official `aws-embedded-metrics` client exists for Rust, hence this
//! small hand-rolled emitter rather than a dependency. Kept alongside the
//! existing Prometheus metrics in `metrics.rs` (not a replacement) — those
//! still back the local-dev `docker compose --profile monitoring` stack.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

const NAMESPACE: &str = "escld/ws-sfu";

fn emit(metric_name: &str, value: f64, unit: &str, dimensions: &[(&str, &str)]) {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let mut dimension_keys: Vec<&str> = Vec::with_capacity(dimensions.len());
    for dimension in dimensions {
        dimension_keys.push(dimension.0);
    }

    let mut line = Map::new();
    line.insert(
        "_aws".to_string(),
        json!({
            "Timestamp": timestamp_ms,
            "CloudWatchMetrics": [{
                "Namespace": NAMESPACE,
                "Dimensions": [dimension_keys],
                "Metrics": [{ "Name": metric_name, "Unit": unit }],
            }],
        }),
    );
    for dimension in dimensions {
        line.insert(dimension.0.to_string(), json!(dimension.1));
    }
    line.insert(metric_name.to_string(), json!(value));

    println!("{}", Value::Object(line));
}

/// A counter increment (e.g. one auth failure, one message sent).
pub fn emit_count(metric_name: &str, dimensions: &[(&str, &str)]) {
    emit(metric_name, 1.0, "Count", dimensions);
}

/// A point-in-time gauge reading (e.g. current sockets connected).
pub fn emit_gauge(metric_name: &str, value: f64) {
    emit(metric_name, value, "Count", &[]);
}
