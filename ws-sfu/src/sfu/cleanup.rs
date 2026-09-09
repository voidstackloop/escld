use serde_json::json;
use socketioxide::extract::SocketRef;

use crate::sfu::recording;
use crate::state::AppState;

/// Shared, idempotent cleanup used by both the explicit `call:leave` event
/// and the raw socket disconnect handler. Safe to call from both without
/// double-firing `call:peerLeft`: it no-ops if the room or the peer within
/// it is already gone.
pub async fn leave_room(state: &AppState, s: &SocketRef, conversation_id: &str) {
    let Some(room) = state.sfu().get(conversation_id).await else {
        return;
    };

    if !room.remove_peer(s.id.as_str()).await {
        return;
    }

    // Nobody left to watch it and nobody left who could stop it - finish any
    // active recording (stop ffmpeg, upload, clean up local files) rather
    // than leaking it for the lifetime of the process.
    if room.is_empty().await {
        if let Some(session) = room.take_recording().await {
            recording::finish(state, conversation_id, session).await;
        }
    }

    state.sfu().remove_if_empty(conversation_id).await;

    let call_room = format!("call:{conversation_id}");
    let _ = s
        .to(call_room.clone())
        .emit("call:peerLeft", &json!({ "socketId": s.id.as_str() }))
        .await;
    s.leave(call_room);
}

/// Runs `leave_room` for every call room this process still thinks the
/// socket might be in - used on raw disconnect, where the client may not
/// have had a chance to send an explicit `call:leave` first.
pub async fn disconnect_all(state: &AppState, s: &SocketRef) {
    for conversation_id in state.sfu().room_ids().await {
        leave_room(state, s, &conversation_id).await;
    }
}
