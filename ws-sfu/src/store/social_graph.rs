use aws_sdk_dynamodb::Client;
use aws_sdk_dynamodb::types::AttributeValue;
use uuid::Uuid;

use crate::config::Config;

const FOLLOWER_PREFIX: &str = "FOLLOWER#";

/// Read-only access to the Java backend's `follows` DynamoDB table — the
/// same "each service reads a shared store directly" pattern
/// `ConversationsRepo` already establishes for `conversations`, just
/// read-only here since nothing in `ws-sfu` ever writes a follow edge.
/// Schema confirmed directly against
/// `backend/src/main/java/com/escld/backend/follow/FollowGraphStore.java`:
/// `pk = "USER#"+userId`, and for the "who follows this user" direction,
/// `sk = "FOLLOWER#"+followerId` — the follower's id is embedded in the
/// sort key itself, not a separate attribute. A soft-deleted (unfollowed)
/// edge carries `deleted = true` and must be filtered out client-side,
/// exactly mirroring `FollowGraphStore::queryIds`'s own `isDeleted` check —
/// this table stores no `deleted`-scoped GSI, so there's no server-side way
/// to filter it out earlier.
pub struct FollowGraphRepo {
    client: Client,
    table: String,
}

impl FollowGraphRepo {
    pub async fn new(config: &Config) -> anyhow::Result<Self> {
        let region = aws_config::Region::new(config.aws_region.clone());
        let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest()).region(region);
        if let Some(endpoint) = &config.dynamodb_endpoint {
            loader = loader.endpoint_url(endpoint);
        }
        let sdk_config = loader.load().await;
        let client = Client::new(&sdk_config);

        Ok(Self {
            client,
            table: config.dynamodb_follows_table.clone(),
        })
    }

    /// Every follower of `streamer_id`, live edges only. Deliberately a
    /// single `Query` with no pagination — mirrors `FollowGraphStore.
    /// listFollowers`'s own identical single-Query/no-pagination scope on
    /// the Java side (DynamoDB's own 1MB-per-query ceiling) rather than
    /// exceeding a limit the Java store itself already accepts.
    pub async fn list_followers(&self, streamer_id: Uuid) -> anyhow::Result<Vec<Uuid>> {
        let output = self
            .client
            .query()
            .table_name(&self.table)
            .key_condition_expression("pk = :pk AND begins_with(sk, :prefix)")
            .expression_attribute_values(":pk", AttributeValue::S(format!("USER#{streamer_id}")))
            .expression_attribute_values(":prefix", AttributeValue::S(FOLLOWER_PREFIX.to_string()))
            .send()
            .await?;

        Ok(parse_followers(output.items()))
    }
}

/// Pulled out of `list_followers` specifically so the real correctness
/// question — does this correctly extract a follower id from `sk` and
/// correctly drop soft-deleted edges — is unit-testable against hand-built
/// items shaped exactly like `FollowGraphStore`'s real writes, without
/// needing a live DynamoDB table (mirroring how `amf0.rs`/`amf3.rs` test
/// byte-level correctness against hand-built fixtures rather than only via
/// round-trips through this crate's own encoder).
fn parse_followers(items: &[std::collections::HashMap<String, AttributeValue>]) -> Vec<Uuid> {
    items
        .iter()
        .filter(|item| !matches!(item.get("deleted"), Some(AttributeValue::Bool(true))))
        .filter_map(|item| {
            let sk = item.get("sk")?.as_s().ok()?;
            sk.strip_prefix(FOLLOWER_PREFIX)?.parse::<Uuid>().ok()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn item(sk: &str, deleted: Option<bool>) -> HashMap<String, AttributeValue> {
        let mut m = HashMap::new();
        m.insert("pk".to_string(), AttributeValue::S("USER#irrelevant".to_string()));
        m.insert("sk".to_string(), AttributeValue::S(sk.to_string()));
        if let Some(deleted) = deleted {
            m.insert("deleted".to_string(), AttributeValue::Bool(deleted));
        }
        m
    }

    #[test]
    fn extracts_the_follower_id_from_the_sort_key() {
        let id = Uuid::new_v4();
        let items = vec![item(&format!("FOLLOWER#{id}"), Some(false))];
        assert_eq!(parse_followers(&items), vec![id]);
    }

    /// The real, easy-to-get-backwards case this table's schema forces:
    /// a soft-deleted (unfollowed) edge is a real item, still present in
    /// the table, and must be excluded — exactly mirroring
    /// `FollowGraphStore.queryIds`'s own `isDeleted` filter on the Java
    /// side, which this Rust reader has no server-side (GSI) way to skip
    /// and must replicate client-side instead.
    #[test]
    fn filters_out_a_soft_deleted_follow_edge() {
        let live = Uuid::new_v4();
        let unfollowed = Uuid::new_v4();
        let items = vec![
            item(&format!("FOLLOWER#{live}"), Some(false)),
            item(&format!("FOLLOWER#{unfollowed}"), Some(true)),
        ];
        assert_eq!(parse_followers(&items), vec![live]);
    }

    /// An item with no `deleted` attribute at all is a live edge (the
    /// attribute is only ever added on unfollow) — must not be treated as
    /// deleted-by-absence.
    #[test]
    fn treats_a_missing_deleted_attribute_as_live() {
        let id = Uuid::new_v4();
        let items = vec![item(&format!("FOLLOWER#{id}"), None)];
        assert_eq!(parse_followers(&items), vec![id]);
    }

    #[test]
    fn skips_an_item_whose_sort_key_id_does_not_parse_as_a_uuid() {
        let items = vec![item("FOLLOWER#not-a-uuid", Some(false))];
        assert_eq!(parse_followers(&items), Vec::<Uuid>::new());
    }
}
