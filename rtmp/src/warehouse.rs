use std::error::Error as StdError;
use std::thread;
use std::time::Duration;

use aws_config::Region;
use rdkafka::ClientContext;
use rdkafka::client::OAuthToken;
use rdkafka::config::ClientConfig;
use rdkafka::message::DeliveryResult;
use rdkafka::producer::{FutureProducer, FutureRecord, ProducerContext};
use tokio::runtime::Handle;
use tokio::time::timeout;
use uuid::Uuid;

use crate::store::postgres::EndedStreamInfo;

const TOPIC_LIVE_ENDED: &str = "live.ended";
const ENVELOPE_VERSION: &str = "1";

/// Wires `rdkafka`'s OAUTHBEARER refresh callback to `aws-msk-iam-sasl-signer`
/// — the same SigV4-presigned-URL token AWS's own Java `aws-msk-iam-auth`
/// library and Node's `aws-msk-iam-sasl-signer-js` (used by bq-sink) generate,
/// just via this crate's own Rust port rather than hand-rolled signing. This
/// exact wiring shape (spawn an OS thread, block that thread on the tokio
/// handle, join it from the sync callback) is the crate's own documented
/// pattern for bridging its async token generator into librdkafka's
/// synchronous callback — not an improvised workaround.
struct MskOAuthContext {
    region: Region,
    runtime: Handle,
}

impl ClientContext for MskOAuthContext {
    const ENABLE_REFRESH_OAUTH_TOKEN: bool = true;

    fn generate_oauth_token(&self, _oauthbearer_config: Option<&str>) -> Result<OAuthToken, Box<dyn StdError>> {
        let region = self.region.clone();
        let runtime = self.runtime.clone();
        let (token, lifetime_ms) = {
            let handle = thread::spawn(move || {
                runtime.block_on(async {
                    timeout(Duration::from_secs(10), aws_msk_iam_sasl_signer::generate_auth_token(region)).await
                })
            });
            // Three `?`s, unwrapping three nested layers: the thread-join
            // Result (its Err mapped from a panic payload to a plain
            // message), the `timeout` wrapper's Elapsed, and finally the
            // signer's own SignerError.
            handle.join().map_err(|_| "MSK OAuth token generation thread panicked")???
        };
        Ok(OAuthToken { token, principal_name: String::new(), lifetime_ms })
    }
}

impl ProducerContext for MskOAuthContext {
    type DeliveryOpaque = ();

    fn delivery(&self, delivery_result: &DeliveryResult<'_>, _delivery_opaque: Self::DeliveryOpaque) {
        if let Err((err, _)) = delivery_result {
            tracing::warn!(error = %err, "failed to deliver warehouse event to Kafka");
        }
    }
}

/// Publishes the `live.ended` warehouse event for a stream that ended via
/// the encoder simply disconnecting (crash, network drop) rather than the
/// app's own "End Stream" button — see `rtmp.rs`'s finalize block, the only
/// call site. A stream ended through the app already gets this event from
/// the Java backend's own `WarehouseEventPublisher.publishLiveEnded`; this
/// closes the one path that publisher never sees. Deliberately mirrors that
/// class's exact envelope shape (`eventId`/`eventType`/`eventVersion`/
/// `occurredAt`/`payload`) so `bq-sink`'s consumer parses either producer's
/// messages identically — see that class's own doc for the convention this
/// follows.
pub struct WarehouseEventPublisher {
    producer: Option<FutureProducer<MskOAuthContext>>,
}

impl WarehouseEventPublisher {
    /// `None` `cluster_arn` (no MSK configured — e.g. local dev) means this
    /// publisher is entirely inert, matching the Java backend's own
    /// `app.kafka.enabled=false` graceful-degradation shape. Resolving
    /// bootstrap brokers and building the producer both happen once, here,
    /// not per-publish — the same up-front-cost-once design `main.rs`
    /// already uses for the S3 client.
    ///
    /// `local_bootstrap_servers` is a local-testing-only escape hatch (see
    /// `Config::kafka_local_bootstrap_servers`'s own doc) — when set, it
    /// takes priority over `cluster_arn` and connects PLAINTEXT directly to
    /// a docker-compose Kafka broker, skipping the AWS `GetBootstrapBrokers`
    /// call and IAM/OAUTHBEARER auth entirely. Never set in a real
    /// environment.
    pub async fn new(cluster_arn: Option<&str>, region: &str, local_bootstrap_servers: Option<&str>) -> Self {
        let build_result = if let Some(bootstrap_servers) = local_bootstrap_servers {
            Self::build_local_producer(bootstrap_servers, region).await
        } else if let Some(cluster_arn) = cluster_arn {
            Self::build_producer(cluster_arn, region).await
        } else {
            return Self { producer: None };
        };

        match build_result {
            Ok(producer) => Self { producer: Some(producer) },
            Err(err) => {
                tracing::warn!(error = %err, "failed to initialize warehouse Kafka producer; live.ended events on encoder disconnect will be dropped");
                Self { producer: None }
            }
        }
    }

    /// Local-testing-only path — see `new`'s own doc. `security.protocol` is
    /// PLAINTEXT, so librdkafka never invokes `MskOAuthContext::generate_oauth_token`
    /// at all; the context is only present because `create_with_context`
    /// needs *a* `ClientContext`, not because OAuth is actually exercised
    /// here. `region` is carried through unused in that case.
    async fn build_local_producer(bootstrap_servers: &str, region: &str) -> anyhow::Result<FutureProducer<MskOAuthContext>> {
        let context = MskOAuthContext { region: Region::new(region.to_string()), runtime: Handle::current() };

        let producer = ClientConfig::new()
            .set("bootstrap.servers", bootstrap_servers)
            .set("security.protocol", "PLAINTEXT")
            .set("message.timeout.ms", "5000")
            .create_with_context(context)?;

        Ok(producer)
    }

    async fn build_producer(cluster_arn: &str, region: &str) -> anyhow::Result<FutureProducer<MskOAuthContext>> {
        let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let kafka_client = aws_sdk_kafka::Client::new(&aws_config);
        let bootstrap_brokers = kafka_client
            .get_bootstrap_brokers()
            .cluster_arn(cluster_arn)
            .send()
            .await?
            .bootstrap_broker_string_sasl_iam()
            .ok_or_else(|| anyhow::anyhow!("MSK cluster has no SASL/IAM bootstrap broker string"))?
            .to_string();

        let context = MskOAuthContext { region: Region::new(region.to_string()), runtime: Handle::current() };

        let producer = ClientConfig::new()
            .set("bootstrap.servers", &bootstrap_brokers)
            .set("security.protocol", "SASL_SSL")
            .set("sasl.mechanism", "OAUTHBEARER")
            // Best-effort, matching every other publisher in this app (see
            // WarehouseEventPublisher.java) — a slow/down cluster must never
            // block the disconnect-handling path this is called from.
            .set("message.timeout.ms", "5000")
            .create_with_context(context)?;

        Ok(producer)
    }

    /// Best-effort, same as every other publisher in this app: a failed
    /// publish is logged, never propagated — this must not turn a Kafka
    /// hiccup into a reason the disconnect-handling path itself fails.
    pub async fn publish_live_ended(&self, post_id: Uuid, ended: &EndedStreamInfo, peak_viewer_count: Option<i32>) {
        let Some(producer) = &self.producer else {
            return;
        };

        let envelope = serde_json::json!({
            "eventId": Uuid::new_v4().to_string(),
            "eventType": TOPIC_LIVE_ENDED,
            "eventVersion": ENVELOPE_VERSION,
            "occurredAt": chrono::Utc::now().to_rfc3339(),
            "payload": {
                "postId": post_id.to_string(),
                "authorId": ended.author_id.to_string(),
                "durationSeconds": ended.duration_seconds,
                "peakViewerCount": peak_viewer_count,
            },
        });
        let body = envelope.to_string();
        let key = post_id.to_string();

        let record = FutureRecord::to(TOPIC_LIVE_ENDED).key(&key).payload(&body);
        if let Err((err, _)) = producer.send(record, Duration::from_secs(5)).await {
            tracing::warn!(error = %err, post_id = %post_id, "failed to publish live.ended warehouse event");
        }
    }
}
