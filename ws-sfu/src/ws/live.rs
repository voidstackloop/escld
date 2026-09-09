use serde::Deserialize;
use serde_json::json;
use socketioxide::extract::{AckSender, Data, Extension, SocketRef, State};

use crate::state::AppState;
use crate::store::postgres;
use crate::types::Identity;

use super::messaging::MAX_MESSAGE_BODY_LEN;

/// Ephemeral, broadcast-only chat for a live stream — deliberately NOT the
/// persisted DM/group `conversations` model `messaging.rs` implements.
/// Chat exists only for as long as someone is connected to the room; there
/// is no DynamoDB write, no message id, no history, and no way to see what
/// was said before you joined. Scoped this way on purpose (a real, stated
/// scope cut, not an oversight): a Twitch-style live chat's whole value is
/// "what's happening right now," and building real persistence/replay,
/// moderator mute/clear controls, or viewer-count surfacing (already
/// covered separately by the Java-side `LiveViewerPresenceServiceImpl`
/// Redis heartbeat — not duplicated here) are each their own follow-up, not
/// bundled into this pass.
///
/// Room naming (`live:<postId>`) is a distinct prefix from both a
/// conversation id (`messaging.rs`) and a `user:<id>` room (`kafka/mod.rs`)
/// so none of the three can ever collide.
fn room_for(post_id: &str) -> String {
    format!("live:{post_id}")
}

fn ok(ack: AckSender, value: serde_json::Value) {
    let _ = ack.send(&value);
}

fn fail(ack: AckSender, message: impl Into<String>) {
    let _ = ack.send(&json!({ "error": message.into() }));
}

fn fail_internal(ack: AckSender, context: &str, err: anyhow::Error) {
    tracing::error!(error = %err, context, "live chat handler failed");
    fail(ack, "internal error");
}

pub fn register(s: &SocketRef) {
    s.on("live:join", join);
    s.on("live:leave", leave);
    s.on("live:chat:send", send_chat);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveJoinReq {
    post_id: String,
}

/// Anyone authenticated may join — unlike a DM/group conversation, live
/// chat has no membership list to check, only a "is this post actually
/// live right now" check.
#[tracing::instrument(
    name = "live:join",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, post_id = %req.post_id)
)]
async fn join(
    s: SocketRef,
    Data(req): Data<LiveJoinReq>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let post_id: uuid::Uuid = match req.post_id.parse() {
        Ok(id) => id,
        Err(_) => return fail(ack, "invalid post id"),
    };

    match postgres::find_live_post_author(state.pg(), post_id).await {
        Ok(Some(author_id)) => {
            s.join(room_for(&req.post_id));
            ok(ack, json!({ "ok": true, "authorId": author_id }));
        }
        Ok(None) => fail(ack, "stream is not live"),
        Err(err) => fail_internal(ack, "live:join", err),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveLeaveReq {
    post_id: String,
}

#[tracing::instrument(
    name = "live:leave",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, post_id = %req.post_id)
)]
async fn leave(s: SocketRef, Data(req): Data<LiveLeaveReq>, Extension(identity): Extension<Identity>) {
    let _ = &identity; // only present for the tracing span above
    s.leave(room_for(&req.post_id));
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveChatSendReq {
    post_id: String,
    body: String,
}

#[tracing::instrument(
    name = "live:chat:send",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, post_id = %req.post_id)
)]
async fn send_chat(
    s: SocketRef,
    Data(req): Data<LiveChatSendReq>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let body = req.body.trim();
    if body.is_empty() || body.chars().count() > MAX_MESSAGE_BODY_LEN {
        return fail(ack, "invalid message body");
    }

    if state.rate_limiters().live_chat_send(s.id.as_str()).check().is_err() {
        return fail(ack, "rate limited");
    }

    let payload = json!({
        "postId": req.post_id,
        "userId": identity.user_id,
        "username": identity.username,
        "body": body,
        "sentAt": chrono::Utc::now().to_rfc3339(),
    });
    let _ = s.to(room_for(&req.post_id)).emit("live:chat:new", &payload).await;
    ok(ack, json!({ "ok": true }));
}
