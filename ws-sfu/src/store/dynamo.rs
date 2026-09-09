use std::collections::HashMap;

use aws_sdk_dynamodb::Client;
use aws_sdk_dynamodb::types::{AttributeValue, Delete, Put, TransactWriteItem, Update};
use chrono::{SecondsFormat, Utc};
use uuid::Uuid;

use crate::config::Config;
use crate::types::{ChatMessage, Conversation, ConversationType};

/// Single-table repo for the `conversations` DynamoDB table. Schema is fixed
/// by `infra/lib/conversations-stack.ts`:
///
///   pk=CONVO#<id>,      sk=META                       -> conversation metadata
///   pk=CONVO#<id>,      sk=MSG#<createdAt>#<msgId>     -> one item per message
///   pk=USER#<id>,       sk=CONVO#<lastMsgAt>#<convoId> -> per-user inbox (denormalized)
///   pk=DMPAIR#<a>#<b>,  sk=META                        -> DM dedup lookup
pub struct ConversationsRepo {
    client: Client,
    table: String,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn s(value: impl Into<String>) -> AttributeValue {
    AttributeValue::S(value.into())
}

fn ss_list(values: &[String]) -> AttributeValue {
    AttributeValue::L(values.iter().map(|v| s(v.clone())).collect())
}

fn get_s(item: &HashMap<String, AttributeValue>, key: &str) -> Option<String> {
    item.get(key).and_then(|v| v.as_s().ok()).cloned()
}

fn get_opt_s(item: &HashMap<String, AttributeValue>, key: &str) -> Option<String> {
    match item.get(key) {
        Some(AttributeValue::Null(_)) | None => None,
        Some(v) => v.as_s().ok().cloned(),
    }
}

fn get_ss_list(item: &HashMap<String, AttributeValue>, key: &str) -> Vec<String> {
    item.get(key)
        .and_then(|v| v.as_l().ok())
        .map(|list| list.iter().filter_map(|v| v.as_s().ok().cloned()).collect())
        .unwrap_or_default()
}

/// Builds the denormalized field set shared by a conversation's own META
/// item and every participant's inbox item for it - both carry the same
/// summary fields so `conversations:list` never needs a second round trip.
fn conversation_fields(convo: &Conversation) -> HashMap<String, AttributeValue> {
    let mut m = HashMap::new();
    m.insert("conversationId".to_string(), s(&convo.id));
    m.insert(
        "type".to_string(),
        s(match convo.kind {
            ConversationType::Dm => "dm",
            ConversationType::Group => "group",
        }),
    );
    m.insert("participantIds".to_string(), ss_list(&convo.participant_ids));
    m.insert(
        "name".to_string(),
        match &convo.name {
            Some(name) => s(name.clone()),
            None => AttributeValue::Null(true),
        },
    );
    m.insert("createdAt".to_string(), s(&convo.created_at));
    m.insert("lastMessageAt".to_string(), s(&convo.last_message_at));
    m.insert(
        "lastMessagePreview".to_string(),
        match &convo.last_message_preview {
            Some(preview) => s(preview.clone()),
            None => AttributeValue::Null(true),
        },
    );
    m
}

fn conversation_from_item(item: &HashMap<String, AttributeValue>) -> anyhow::Result<Conversation> {
    let id = get_s(item, "conversationId").ok_or_else(|| anyhow::anyhow!("missing conversationId"))?;
    let kind = match get_s(item, "type").as_deref() {
        Some("group") => ConversationType::Group,
        _ => ConversationType::Dm,
    };
    Ok(Conversation {
        id,
        kind,
        participant_ids: get_ss_list(item, "participantIds"),
        name: get_opt_s(item, "name"),
        created_at: get_s(item, "createdAt").unwrap_or_default(),
        last_message_at: get_s(item, "lastMessageAt").unwrap_or_default(),
        last_message_preview: get_opt_s(item, "lastMessagePreview"),
    })
}

fn message_from_item(item: &HashMap<String, AttributeValue>) -> anyhow::Result<ChatMessage> {
    Ok(ChatMessage {
        id: get_s(item, "id").ok_or_else(|| anyhow::anyhow!("missing id"))?,
        conversation_id: get_s(item, "conversationId").unwrap_or_default(),
        sender_id: get_s(item, "senderId").unwrap_or_default(),
        body: get_s(item, "body").unwrap_or_default(),
        created_at: get_s(item, "createdAt").unwrap_or_default(),
    })
}

fn dmpair_key(a: &str, b: &str) -> String {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    format!("DMPAIR#{lo}#{hi}")
}

impl ConversationsRepo {
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
            table: config.dynamodb_conversations_table.clone(),
        })
    }

    /// `conversations:list` - one Query against the caller's own inbox
    /// partition, newest-first (the sort key embeds `lastMessageAt`).
    pub async fn list_conversations(&self, user_id: &str) -> anyhow::Result<Vec<Conversation>> {
        let output = self
            .client
            .query()
            .table_name(&self.table)
            .key_condition_expression("pk = :pk AND begins_with(sk, :prefix)")
            .expression_attribute_values(":pk", s(format!("USER#{user_id}")))
            .expression_attribute_values(":prefix", s("CONVO#"))
            .scan_index_forward(false)
            .send()
            .await?;

        output
            .items()
            .iter()
            .map(conversation_from_item)
            .collect()
    }

    /// `conversations:list` authorization / `messages:*` membership check.
    pub async fn get_conversation(&self, conversation_id: &str) -> anyhow::Result<Option<Conversation>> {
        let output = self
            .client
            .get_item()
            .table_name(&self.table)
            .key("pk", s(format!("CONVO#{conversation_id}")))
            .key("sk", s("META"))
            .send()
            .await?;

        output.item().map(conversation_from_item).transpose()
    }

    /// `conversations:openDm` - atomically dedupes on `DMPAIR#<a>#<b>` (keys
    /// canonically ordered so the pair is symmetric); on collision, fetches
    /// the existing conversation instead of erroring.
    pub async fn open_dm(&self, user_id: &str, peer_user_id: &str) -> anyhow::Result<Conversation> {
        if user_id == peer_user_id {
            anyhow::bail!("cannot open a DM with yourself");
        }

        let dmpair_pk = dmpair_key(user_id, peer_user_id);
        let new_id = Uuid::new_v4().to_string();
        let now = now_iso();

        let convo = Conversation {
            id: new_id.clone(),
            kind: ConversationType::Dm,
            participant_ids: vec![user_id.to_string(), peer_user_id.to_string()],
            name: None,
            created_at: now.clone(),
            last_message_at: now,
            last_message_preview: None,
        };
        let fields = conversation_fields(&convo);

        let mut meta_item = fields.clone();
        meta_item.insert("pk".to_string(), s(format!("CONVO#{new_id}")));
        meta_item.insert("sk".to_string(), s("META"));

        let mut dmpair_item = HashMap::new();
        dmpair_item.insert("pk".to_string(), s(&dmpair_pk));
        dmpair_item.insert("sk".to_string(), s("META"));
        dmpair_item.insert("conversationId".to_string(), s(&new_id));

        let mut items = vec![
            TransactWriteItem::builder()
                .put(
                    Put::builder()
                        .table_name(&self.table)
                        .set_item(Some(dmpair_item))
                        .condition_expression("attribute_not_exists(pk)")
                        .build()?,
                )
                .build(),
            TransactWriteItem::builder()
                .put(
                    Put::builder()
                        .table_name(&self.table)
                        .set_item(Some(meta_item))
                        .build()?,
                )
                .build(),
        ];

        for participant in [user_id, peer_user_id] {
            let mut inbox_item = fields.clone();
            inbox_item.insert("pk".to_string(), s(format!("USER#{participant}")));
            inbox_item.insert(
                "sk".to_string(),
                s(format!("CONVO#{}#{new_id}", convo.last_message_at)),
            );
            items.push(
                TransactWriteItem::builder()
                    .put(
                        Put::builder()
                            .table_name(&self.table)
                            .set_item(Some(inbox_item))
                            .build()?,
                    )
                    .build(),
            );
        }

        let result = self
            .client
            .transact_write_items()
            .set_transact_items(Some(items))
            .send()
            .await;

        match result {
            Ok(_) => Ok(convo),
            Err(err) => {
                let is_conflict = err
                    .as_service_error()
                    .map(|e| e.is_transaction_canceled_exception())
                    .unwrap_or(false);
                if !is_conflict {
                    return Err(err.into());
                }

                // Someone won the race (or the DM already existed): look up
                // the existing pair, then its conversation, and return that.
                let dmpair = self
                    .client
                    .get_item()
                    .table_name(&self.table)
                    .key("pk", s(&dmpair_pk))
                    .key("sk", s("META"))
                    .send()
                    .await?;
                let existing_id = dmpair
                    .item()
                    .and_then(|item| get_s(item, "conversationId"))
                    .ok_or_else(|| anyhow::anyhow!("DM pair conflict but no existing conversation found"))?;

                self.get_conversation(&existing_id)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("existing DM conversation vanished"))
            }
        }
    }

    /// `conversations:createGroup` - no dedup needed, just META + one inbox
    /// item per participant (including the creator, added by the caller).
    pub async fn create_group(&self, participant_ids: &[String], name: &str) -> anyhow::Result<Conversation> {
        let new_id = Uuid::new_v4().to_string();
        let now = now_iso();

        let convo = Conversation {
            id: new_id.clone(),
            kind: ConversationType::Group,
            participant_ids: participant_ids.to_vec(),
            name: Some(name.to_string()),
            created_at: now.clone(),
            last_message_at: now,
            last_message_preview: None,
        };
        let fields = conversation_fields(&convo);

        let mut meta_item = fields.clone();
        meta_item.insert("pk".to_string(), s(format!("CONVO#{new_id}")));
        meta_item.insert("sk".to_string(), s("META"));

        let mut items = vec![
            TransactWriteItem::builder()
                .put(
                    Put::builder()
                        .table_name(&self.table)
                        .set_item(Some(meta_item))
                        .build()?,
                )
                .build(),
        ];

        for participant in participant_ids {
            let mut inbox_item = fields.clone();
            inbox_item.insert("pk".to_string(), s(format!("USER#{participant}")));
            inbox_item.insert(
                "sk".to_string(),
                s(format!("CONVO#{}#{new_id}", convo.last_message_at)),
            );
            items.push(
                TransactWriteItem::builder()
                    .put(
                        Put::builder()
                            .table_name(&self.table)
                            .set_item(Some(inbox_item))
                            .build()?,
                    )
                    .build(),
            );
        }

        self.client
            .transact_write_items()
            .set_transact_items(Some(items))
            .send()
            .await?;

        Ok(convo)
    }

    /// `messages:list` - newest-first page of a conversation's MSG items.
    pub async fn list_messages(
        &self,
        conversation_id: &str,
        before: Option<&str>,
        limit: i32,
    ) -> anyhow::Result<Vec<ChatMessage>> {
        let mut query = self
            .client
            .query()
            .table_name(&self.table)
            .scan_index_forward(false)
            .limit(limit)
            .expression_attribute_values(":pk", s(format!("CONVO#{conversation_id}")));

        query = if let Some(before) = before {
            query
                .key_condition_expression("pk = :pk AND sk < :beforeSk")
                .expression_attribute_values(":beforeSk", s(format!("MSG#{before}")))
        } else {
            query
                .key_condition_expression("pk = :pk AND begins_with(sk, :prefix)")
                .expression_attribute_values(":prefix", s("MSG#"))
        };

        let output = query.send().await?;
        output.items().iter().map(message_from_item).collect()
    }

    /// `messages:send` - retries a bounded number of times on an optimistic
    /// concurrency collision against the conversation META item.
    /// `prefetched_convo` lets a caller that already fetched the
    /// conversation for its own membership check (see ws/messaging.rs) skip
    /// one redundant DynamoDB read - but only for the *first* attempt.
    /// `last_message_at` is this transaction's optimistic-concurrency CAS
    /// condition (below), so every retry after a conflicting concurrent
    /// send must re-read the real current value, never reuse a value that's
    /// now known to be stale.
    pub async fn send_message(
        &self,
        conversation_id: &str,
        sender_id: &str,
        body: &str,
        prefetched_convo: Option<Conversation>,
    ) -> anyhow::Result<ChatMessage> {
        const MAX_ATTEMPTS: u32 = 3;
        let mut prefetched = prefetched_convo;

        for attempt in 1..=MAX_ATTEMPTS {
            let convo = match prefetched.take() {
                Some(convo) => convo,
                None => self
                    .get_conversation(conversation_id)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("conversation not found"))?,
            };

            if !convo.participant_ids.iter().any(|p| p == sender_id) {
                anyhow::bail!("not a participant of this conversation");
            }

            let msg_id = Uuid::new_v4().to_string();
            let now = now_iso();
            let preview: String = body.chars().take(200).collect();

            let mut msg_item = HashMap::new();
            msg_item.insert("pk".to_string(), s(format!("CONVO#{conversation_id}")));
            msg_item.insert("sk".to_string(), s(format!("MSG#{now}#{msg_id}")));
            msg_item.insert("id".to_string(), s(&msg_id));
            msg_item.insert("conversationId".to_string(), s(conversation_id));
            msg_item.insert("senderId".to_string(), s(sender_id));
            msg_item.insert("body".to_string(), s(body));
            msg_item.insert("createdAt".to_string(), s(&now));

            let mut items = vec![
                TransactWriteItem::builder()
                    .put(
                        Put::builder()
                            .table_name(&self.table)
                            .set_item(Some(msg_item))
                            .build()?,
                    )
                    .build(),
                TransactWriteItem::builder()
                    .update(
                        Update::builder()
                            .table_name(&self.table)
                            .key("pk", s(format!("CONVO#{conversation_id}")))
                            .key("sk", s("META"))
                            .update_expression(
                                "SET lastMessageAt = :new, lastMessagePreview = :preview",
                            )
                            .condition_expression("lastMessageAt = :old")
                            .expression_attribute_values(":new", s(&now))
                            .expression_attribute_values(":preview", s(&preview))
                            .expression_attribute_values(":old", s(&convo.last_message_at))
                            .build()?,
                    )
                    .build(),
            ];

            for participant in &convo.participant_ids {
                items.push(
                    TransactWriteItem::builder()
                        .delete(
                            Delete::builder()
                                .table_name(&self.table)
                                .key("pk", s(format!("USER#{participant}")))
                                .key(
                                    "sk",
                                    s(format!("CONVO#{}#{conversation_id}", convo.last_message_at)),
                                )
                                .build()?,
                        )
                        .build(),
                );

                let mut inbox_item = HashMap::new();
                inbox_item.insert("pk".to_string(), s(format!("USER#{participant}")));
                inbox_item.insert("sk".to_string(), s(format!("CONVO#{now}#{conversation_id}")));
                inbox_item.insert("conversationId".to_string(), s(conversation_id));
                inbox_item.insert(
                    "type".to_string(),
                    s(match convo.kind {
                        ConversationType::Dm => "dm",
                        ConversationType::Group => "group",
                    }),
                );
                inbox_item.insert("participantIds".to_string(), ss_list(&convo.participant_ids));
                inbox_item.insert(
                    "name".to_string(),
                    match &convo.name {
                        Some(name) => s(name.clone()),
                        None => AttributeValue::Null(true),
                    },
                );
                inbox_item.insert("createdAt".to_string(), s(&convo.created_at));
                inbox_item.insert("lastMessageAt".to_string(), s(&now));
                inbox_item.insert("lastMessagePreview".to_string(), s(&preview));

                items.push(
                    TransactWriteItem::builder()
                        .put(
                            Put::builder()
                                .table_name(&self.table)
                                .set_item(Some(inbox_item))
                                .build()?,
                        )
                        .build(),
                );
            }

            let result = self
                .client
                .transact_write_items()
                .set_transact_items(Some(items))
                .send()
                .await;

            match result {
                Ok(_) => {
                    return Ok(ChatMessage {
                        id: msg_id,
                        conversation_id: conversation_id.to_string(),
                        sender_id: sender_id.to_string(),
                        body: body.to_string(),
                        created_at: now,
                    });
                }
                Err(err) => {
                    let is_conflict = err
                        .as_service_error()
                        .map(|e| e.is_transaction_canceled_exception())
                        .unwrap_or(false);
                    if !is_conflict || attempt == MAX_ATTEMPTS {
                        return Err(err.into());
                    }
                    tracing::debug!(attempt, "messages:send lost an optimistic-concurrency race, retrying");
                }
            }
        }

        unreachable!("loop always returns or errors")
    }
}
