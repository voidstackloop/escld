use std::collections::HashSet;
use std::error::Error as StdError;
use std::thread;
use std::time::Duration;

use aws_config::Region;
use rand::RngExt;
use rdkafka::ClientContext;
use rdkafka::client::OAuthToken;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{Consumer, ConsumerContext, StreamConsumer};
use rdkafka::message::Message;
use serde_json::Value;
use socketioxide::SocketIo;
use tokio::runtime::Handle;
use tokio::time::timeout;
use uuid::Uuid;

use crate::state::AppState;
use crate::store::postgres;
use crate::types::Identity;

const TOPIC_LIVE_STARTED: &str = "live.started";
const TOPIC_LIVE_ENDED: &str = "live.ended";

/// Identical MSK IAM/OAUTHBEARER bridging to `rtmp/src/warehouse.rs`'s
/// producer-side `MskOAuthContext` — same SigV4-presigned-URL token via
/// `aws-msk-iam-sasl-signer`, same spawn-thread-block-on-runtime pattern for
/// bridging its async token generator into librdkafka's synchronous
/// callback. `ConsumerContext` (unlike `ProducerContext`) has only
/// default-provided methods, so implementing it here needs no additional
/// callback logic beyond `ClientContext`.
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
            handle.join().map_err(|_| "MSK OAuth token generation thread panicked")???
        };
        Ok(OAuthToken { token, principal_name: String::new(), lifetime_ms })
    }
}

impl ConsumerContext for MskOAuthContext {}

/// Bridges `live.started`/`live.ended` Kafka events into a real-time push
/// over the same Socket.IO connections `ws-sfu` already holds for every
/// authenticated user — closing the gap where going live today only ever
/// updates what a viewer sees on their *next* feed fetch, never pushes
/// anything to someone already looking at their feed.
///
/// **Critical, easy-to-miss correctness constraint**: `group_id` below is a
/// fresh UUID generated once per process start, never a fixed shared value.
/// If `ws-sfu` ever scales horizontally (already named in docs/WS_SFU.md as
/// the eventual next step once SOCKETS_CONNECTED/ROOMS_ACTIVE show a
/// ceiling), a *shared* consumer group across instances would mean Kafka
/// partitions the work across them — each `live.started`/`live.ended`
/// message would only reach ONE instance's consumer, silently breaking
/// delivery to every user connected to every other instance. A future
/// "cleanup" that hardcodes this to a fixed group id would reintroduce that
/// bug silently. `auto.offset.reset=latest` is what makes a disposable
/// per-instance group id correct in the first place — this consumer only
/// ever wants events from now on, never a replay of history it has no
/// meaningful offset for anyway.
///
/// Entirely inert when no MSK cluster is configured (`cluster_arn` and
/// `local_bootstrap_servers` both absent) — same graceful-degradation shape
/// as every other optional integration in this app.
pub async fn spawn(io: SocketIo, state: AppState) {
    let config = state.config();
    let consumer = match build_consumer(config.kafka_cluster_arn.as_deref(), &config.kafka_region, config.kafka_local_bootstrap_servers.as_deref()).await {
        Some(Ok(consumer)) => consumer,
        Some(Err(err)) => {
            tracing::warn!(error = %err, "failed to initialize live-feed Kafka consumer; going live will not push a real-time feed update");
            return;
        }
        None => return,
    };

    if let Err(err) = consumer.subscribe(&[TOPIC_LIVE_STARTED, TOPIC_LIVE_ENDED]) {
        tracing::warn!(error = %err, "failed to subscribe the live-feed Kafka consumer to its topics");
        return;
    }

    tracing::info!("live-feed Kafka consumer subscribed, listening for live.started/live.ended");

    loop {
        match consumer.recv().await {
            Ok(message) => {
                let Some(payload) = message.payload() else { continue };
                let topic = message.topic().to_string();
                match serde_json::from_slice::<Value>(payload) {
                    Ok(envelope) => handle_event(&io, &state, &topic, &envelope).await,
                    Err(err) => tracing::warn!(error = %err, topic, "failed to parse a live-feed Kafka message as JSON"),
                }
            }
            Err(err) => {
                tracing::warn!(error = %err, "live-feed Kafka consumer receive error");
            }
        }
    }
}

async fn build_consumer(
    cluster_arn: Option<&str>,
    region: &str,
    local_bootstrap_servers: Option<&str>,
) -> Option<anyhow::Result<StreamConsumer<MskOAuthContext>>> {
    if let Some(bootstrap_servers) = local_bootstrap_servers {
        Some(build_local_consumer(bootstrap_servers, region).await)
    } else if let Some(cluster_arn) = cluster_arn {
        Some(build_msk_consumer(cluster_arn, region).await)
    } else {
        None
    }
}

fn group_id() -> String {
    format!("ws-sfu-live-push-{}", Uuid::new_v4())
}

/// Local-testing-only path (see `Config::kafka_local_bootstrap_servers`'s
/// own doc) — PLAINTEXT, so `MskOAuthContext::generate_oauth_token` is never
/// actually invoked; the context is only present because
/// `create_with_context` needs *a* `ClientContext`.
async fn build_local_consumer(bootstrap_servers: &str, region: &str) -> anyhow::Result<StreamConsumer<MskOAuthContext>> {
    let context = MskOAuthContext { region: Region::new(region.to_string()), runtime: Handle::current() };

    let consumer = ClientConfig::new()
        .set("bootstrap.servers", bootstrap_servers)
        .set("security.protocol", "PLAINTEXT")
        .set("group.id", group_id())
        .set("auto.offset.reset", "latest")
        .set("enable.auto.commit", "true")
        .create_with_context(context)?;

    Ok(consumer)
}

async fn build_msk_consumer(cluster_arn: &str, region: &str) -> anyhow::Result<StreamConsumer<MskOAuthContext>> {
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

    let consumer = ClientConfig::new()
        .set("bootstrap.servers", &bootstrap_brokers)
        .set("security.protocol", "SASL_SSL")
        .set("sasl.mechanism", "OAUTHBEARER")
        .set("group.id", group_id())
        .set("auto.offset.reset", "latest")
        .set("enable.auto.commit", "true")
        .create_with_context(context)?;

    Ok(consumer)
}

async fn handle_event(io: &SocketIo, state: &AppState, topic: &str, envelope: &Value) {
    let payload = &envelope["payload"];
    let Some(post_id) = payload["postId"].as_str() else {
        tracing::warn!(topic, "live-feed Kafka event missing postId");
        return;
    };
    let Some(author_id) = payload["authorId"].as_str().and_then(|s| s.parse::<Uuid>().ok()) else {
        tracing::warn!(topic, post_id, "live-feed Kafka event missing or invalid authorId");
        return;
    };

    match topic {
        TOPIC_LIVE_STARTED => {
            let title = payload["title"].as_str().unwrap_or_default();
            let author_username = match postgres::find_username(state.pg(), author_id).await {
                Ok(username) => username.unwrap_or_default(),
                Err(err) => {
                    tracing::warn!(error = %err, author_id = %author_id, "failed to resolve author username for a live-feed push; pushing with a blank name");
                    String::new()
                }
            };
            let event_payload = serde_json::json!({
                "postId": post_id,
                "authorId": author_id,
                "authorUsername": author_username,
                "title": title,
            });
            deliver_live_event(io, state, author_id, "feed:liveStarted", &event_payload).await;
        }
        TOPIC_LIVE_ENDED => {
            let event_payload = serde_json::json!({ "postId": post_id, "authorId": author_id });
            deliver_live_event(io, state, author_id, "feed:liveEnded", &event_payload).await;
        }
        _ => {}
    }
}

/// Weighted delivery: the streamer's online followers get near-certain
/// delivery (`live_push_follower_weight`, default 1.0), independently
/// sampled per follower; every other currently-connected user gets a much
/// smaller, independently-sampled chance (`live_push_discovery_weight`,
/// default 0.1) — a discovery mechanic, not a full broadcast. Deliberately
/// two independent per-socket coin flips rather than a shared audience
/// pool: neither needs any stable bookkeeping beyond "who follows this
/// streamer" (already a single DynamoDB Query) and "who's connected right
/// now" (`io.sockets()`, already free — see below).
async fn deliver_live_event(io: &SocketIo, state: &AppState, streamer_id: Uuid, event: &str, payload: &Value) {
    let followers = state.follow_graph().list_followers(streamer_id).await.unwrap_or_else(|err| {
        tracing::warn!(error = %err, streamer_id = %streamer_id, "failed to look up followers for a live-feed push");
        Vec::new()
    });
    let follower_ids: HashSet<Uuid> = followers.iter().copied().collect();

    let follower_weight = state.config().live_push_follower_weight;
    let rooms: Vec<String> = select_by_weight(&followers, follower_weight).into_iter().map(|id| format!("user:{id}")).collect();
    if !rooms.is_empty() {
        let _ = io.to(rooms).emit(event, payload).await;
    }

    // `io.sockets()` returns every currently-connected socket in the
    // default namespace — this IS the discovery-pool enumeration, no
    // separate presence registry needed. O(connected-socket-count) per
    // live-transition event, evaluated only on the rare live.started/
    // live.ended events, not per-request — fine at this app's scale; worth
    // revisiting only if connection counts grow much faster than
    // live-transition frequency, which isn't the current bottleneck
    // direction. Fetched once and reused for both the candidate-selection
    // pass and the delivery pass below, rather than walking the connected-
    // socket list twice.
    let all_sockets = io.sockets();
    // Deduped to one entry per *user*, not per socket - select_by_weight
    // rolls its RNG once per entry, so a user with multiple open
    // tabs/devices would otherwise get one independent roll per socket,
    // inflating their real chance of being selected well above
    // `live_push_discovery_weight` (e.g. two 10% rolls is a ~19% chance of
    // at least one hit, not 10%). Mirrors the follower path, which is
    // already correctly deduped via list_followers.
    let discovery_candidates: Vec<Uuid> = all_sockets
        .iter()
        .filter_map(|socket| socket.extensions.get::<Identity>().map(|identity| identity.user_id))
        .filter(|user_id| *user_id != streamer_id && !follower_ids.contains(user_id))
        .collect::<HashSet<Uuid>>()
        .into_iter()
        .collect();
    let discovery_weight = state.config().live_push_discovery_weight;
    let selected: HashSet<Uuid> = select_by_weight(&discovery_candidates, discovery_weight).into_iter().collect();
    if !selected.is_empty() {
        for socket in &all_sockets {
            let Some(identity) = socket.extensions.get::<Identity>() else { continue };
            if selected.contains(&identity.user_id) {
                let _ = socket.emit(event, payload);
            }
        }
    }
}

/// Independent per-item sampling: each item is kept with probability
/// `weight` (clamped implicitly by `f64`'s `<` comparison against a
/// `[0.0, 1.0)` roll — a `weight` of `1.0` always keeps every item, `0.0`
/// always drops every item, both deterministic regardless of the RNG,
/// which is exactly what makes those two boundary weights meaningfully
/// unit-testable below without injecting a fake RNG.
fn select_by_weight<T: Clone>(items: &[T], weight: f64) -> Vec<T> {
    items.iter().filter(|_| rand::rng().random::<f64>() < weight).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_weight_of_one_always_selects_every_item() {
        let items: Vec<u32> = (0..50).collect();
        assert_eq!(select_by_weight(&items, 1.0), items);
    }

    #[test]
    fn a_weight_of_zero_never_selects_any_item() {
        let items: Vec<u32> = (0..50).collect();
        assert!(select_by_weight(&items, 0.0).is_empty());
    }

    #[test]
    fn an_empty_input_selects_nothing_regardless_of_weight() {
        let items: Vec<u32> = Vec::new();
        assert!(select_by_weight(&items, 1.0).is_empty());
    }
}
