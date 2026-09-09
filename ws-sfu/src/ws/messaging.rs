use serde::Deserialize;
use serde_json::json;
use socketioxide::extract::{AckSender, Data, Extension, SocketRef, State};

use crate::metrics;
use crate::state::AppState;
use crate::types::Identity;

const MAX_GROUP_PARTICIPANTS: usize = 40;
/// `pub(crate)` so `ws/live.rs::send_chat` can reuse the exact same body-
/// length limit for live chat rather than duplicating the constant.
pub(crate) const MAX_MESSAGE_BODY_LEN: usize = 4000;
const MAX_GROUP_NAME_LEN: usize = 100;

fn ok(ack: AckSender, value: serde_json::Value) {
    let _ = ack.send(&value);
}

fn fail(ack: AckSender, message: impl Into<String>) {
    let _ = ack.send(&json!({ "error": message.into() }));
}

/// Logs the real error server-side and sends back a generic message -
/// internal store/SDK failures should never reach the client verbatim.
fn fail_internal(ack: AckSender, context: &str, err: anyhow::Error) {
    tracing::error!(error = %err, context, "messaging handler failed");
    fail(ack, "internal error");
}

pub fn register(s: &SocketRef) {
    s.on("conversations:list", list_conversations);
    s.on("conversations:openDm", open_dm);
    s.on("conversations:createGroup", create_group);
    s.on("messages:list", list_messages);
    s.on("messages:send", send_message);
}

#[tracing::instrument(
    name = "conversations:list",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id)
)]
async fn list_conversations(
    s: SocketRef,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    match state.dynamo().list_conversations(&identity.user_id.to_string()).await {
        Ok(conversations) => {
            for convo in &conversations {
                s.join(convo.id.clone());
            }
            ok(ack, json!({ "conversations": conversations }));
        }
        Err(err) => fail_internal(ack, "conversations:list", err),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenDmReq {
    peer_user_id: String,
}

#[tracing::instrument(
    name = "conversations:openDm",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id)
)]
async fn open_dm(
    s: SocketRef,
    Data(req): Data<OpenDmReq>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let user_id = identity.user_id.to_string();
    if req.peer_user_id == user_id {
        return fail(ack, "cannot open a DM with yourself");
    }

    match state.dynamo().open_dm(&user_id, &req.peer_user_id).await {
        Ok(conversation) => {
            s.join(conversation.id.clone());
            ok(ack, json!({ "conversation": conversation }));
        }
        Err(err) => fail_internal(ack, "conversations:openDm", err),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateGroupReq {
    participant_ids: Vec<String>,
    name: String,
}

#[tracing::instrument(
    name = "conversations:createGroup",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, participant_count = req.participant_ids.len())
)]
async fn create_group(
    s: SocketRef,
    Data(req): Data<CreateGroupReq>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > MAX_GROUP_NAME_LEN {
        return fail(ack, "invalid group name");
    }

    let user_id = identity.user_id.to_string();
    let mut participant_ids: Vec<String> = req.participant_ids;
    if !participant_ids.iter().any(|p| p == &user_id) {
        participant_ids.push(user_id);
    }
    participant_ids.sort();
    participant_ids.dedup();

    if participant_ids.len() < 2 {
        return fail(ack, "a group needs at least two participants");
    }
    if participant_ids.len() > MAX_GROUP_PARTICIPANTS {
        return fail(ack, "too many participants for a group");
    }

    match state.dynamo().create_group(&participant_ids, name).await {
        Ok(conversation) => {
            s.join(conversation.id.clone());
            ok(ack, json!({ "conversation": conversation }));
        }
        Err(err) => fail_internal(ack, "conversations:createGroup", err),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagesListReq {
    conversation_id: String,
    before: Option<String>,
}

#[tracing::instrument(
    name = "messages:list",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id)
)]
async fn list_messages(
    s: SocketRef,
    Data(req): Data<MessagesListReq>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let user_id = identity.user_id.to_string();

    let convo = match state.dynamo().get_conversation(&req.conversation_id).await {
        Ok(Some(convo)) => convo,
        Ok(None) => return fail(ack, "conversation not found"),
        Err(err) => return fail_internal(ack, "messages:list", err),
    };
    if !convo.participant_ids.iter().any(|p| p == &user_id) {
        return fail(ack, "forbidden");
    }

    s.join(req.conversation_id.clone());

    match state
        .dynamo()
        .list_messages(&req.conversation_id, req.before.as_deref(), 50)
        .await
    {
        Ok(messages) => ok(ack, json!({ "messages": messages })),
        Err(err) => fail_internal(ack, "messages:list", err),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagesSendReq {
    conversation_id: String,
    body: String,
}

#[tracing::instrument(
    name = "messages:send",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id)
)]
async fn send_message(
    s: SocketRef,
    Data(req): Data<MessagesSendReq>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let body = req.body.trim();
    if body.is_empty() || body.chars().count() > MAX_MESSAGE_BODY_LEN {
        return fail(ack, "invalid message body");
    }

    if state.rate_limiters().messages_send(s.id.as_str()).check().is_err() {
        return fail(ack, "rate limited");
    }

    let user_id = identity.user_id.to_string();

    let convo = match state.dynamo().get_conversation(&req.conversation_id).await {
        Ok(Some(convo)) => convo,
        Ok(None) => return fail(ack, "conversation not found"),
        Err(err) => return fail_internal(ack, "messages:send", err),
    };
    if !convo.participant_ids.iter().any(|p| p == &user_id) {
        return fail(ack, "forbidden");
    }

    match state
        .dynamo()
        .send_message(&req.conversation_id, &user_id, body, Some(convo))
        .await
    {
        Ok(message) => {
            metrics::MESSAGES_SENT_TOTAL.inc();
            crate::emf::emit_count("ws_sfu_messages_sent_total", &[]);
            let _ = s
                .to(req.conversation_id.clone())
                .emit("messages:new", &json!({ "conversationId": req.conversation_id, "message": &message }))
                .await;
            ok(ack, json!({ "message": message }));
        }
        Err(err) => fail_internal(ack, "messages:send", err),
    }
}
