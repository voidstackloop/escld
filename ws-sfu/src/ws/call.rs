use std::time::Duration;

use mediasoup::prelude::*;
use serde::Deserialize;
use serde_json::json;
use socketioxide::extract::{AckSender, Data, Extension, SocketRef, State};

use crate::metrics;
use crate::sfu::cleanup;
use crate::sfu::room::{ProducerSource, Room};
use crate::state::AppState;
use crate::types::Identity;

/// How long a `call:join`-time membership check stays trusted before a
/// call:* handler re-fetches the conversation from DynamoDB - see
/// authorize_for_room. Short enough that a participant removed mid-call
/// loses access quickly; long enough that a burst of mute toggles/hand
/// raises doesn't cost a DynamoDB round trip per event.
const AUTHORIZATION_CACHE_TTL: Duration = Duration::from_secs(30);

fn ok(ack: AckSender, value: serde_json::Value) {
    let _ = ack.send(&value);
}

fn fail(ack: AckSender, message: impl Into<String>) {
    let _ = ack.send(&json!({ "error": message.into() }));
}

fn fail_internal(ack: AckSender, context: &str, err: anyhow::Error) {
    tracing::error!(error = %err, context, "call handler failed");
    fail(ack, "internal error");
}

pub fn register(s: &SocketRef) {
    s.on("call:join", join);
    s.on("call:createTransport", create_transport);
    s.on("call:connectTransport", connect_transport);
    s.on("call:produce", produce);
    s.on("call:consume", consume);
    s.on("call:resumeConsumer", resume_consumer);
    s.on("call:pauseProducer", pause_producer);
    s.on("call:resumeProducer", resume_producer);
    s.on("call:raiseHand", raise_hand);
    s.on("call:lowerHand", lower_hand);
    s.on("call:startRecording", start_recording);
    s.on("call:stopRecording", stop_recording);
    s.on("call:leave", leave);
}

pub async fn cleanup_on_disconnect(s: &SocketRef, state: &AppState) {
    cleanup::disconnect_all(state, s).await;
}

/// Every call:* handler operates on a conversationId the client supplies -
/// re-validate membership rather than trusting `call:join`'s own check holds
/// forever. A bare DynamoDB fetch, used directly only by `join` itself
/// (before a Room/Peer exists to cache anything against) - every other
/// handler goes through `authorize_for_room` instead.
async fn authorize(state: &AppState, user_id: &str, conversation_id: &str) -> anyhow::Result<bool> {
    let convo = state.dynamo().get_conversation(conversation_id).await?;
    Ok(convo
        .map(|c| c.participant_ids.iter().any(|p| p == user_id))
        .unwrap_or(false))
}

/// Same membership check as `authorize`, but backed by the room's own
/// per-peer `authorized_at` cache (see sfu/room.rs) so a burst of high
/// -frequency events on one socket (mute toggles, hand raises) doesn't cost
/// a DynamoDB round trip each time - only the first check after
/// AUTHORIZATION_CACHE_TTL expires re-fetches the conversation.
async fn authorize_for_room(
    state: &AppState,
    room: &Room,
    socket_id: &str,
    user_id: &str,
    conversation_id: &str,
) -> anyhow::Result<bool> {
    if room.is_recently_authorized(socket_id, AUTHORIZATION_CACHE_TTL).await {
        return Ok(true);
    }
    let authorized = authorize(state, user_id, conversation_id).await?;
    if authorized {
        room.mark_authorized(socket_id).await;
    }
    Ok(authorized)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationScoped {
    conversation_id: String,
}

#[tracing::instrument(
    name = "call:join",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id)
)]
async fn join(
    s: SocketRef,
    Data(req): Data<ConversationScoped>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let user_id = identity.user_id.to_string();
    match authorize(&state, &user_id, &req.conversation_id).await {
        Ok(true) => {}
        Ok(false) => return fail(ack, "forbidden"),
        Err(err) => return fail_internal(ack, "call:join", err),
    }

    let room = match state.sfu().get_or_create(&req.conversation_id).await {
        Ok(room) => room,
        Err(err) => return fail_internal(ack, "call:join", err),
    };
    room.ensure_peer(s.id.as_str(), &user_id, &identity.username).await;

    let other_producers = room.producer_infos(s.id.as_str()).await;
    let rtp_capabilities = room.rtp_capabilities();
    let recording_started_by = room.recording_started_by().await;

    s.join(format!("call:{}", req.conversation_id));

    ok(
        ack,
        json!({
            "rtpCapabilities": rtp_capabilities,
            "otherProducers": other_producers,
            "recording": recording_started_by.is_some(),
            "recordingStartedByUsername": recording_started_by,
        }),
    );
}

#[tracing::instrument(
    name = "call:createTransport",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id)
)]
async fn create_transport(
    s: SocketRef,
    Data(req): Data<ConversationScoped>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let user_id = identity.user_id.to_string();
    let Some(room) = state.sfu().get(&req.conversation_id).await else {
        return fail(ack, "not in a call for this conversation");
    };
    match authorize_for_room(&state, &room, s.id.as_str(), &user_id, &req.conversation_id).await {
        Ok(true) => {}
        Ok(false) => return fail(ack, "forbidden"),
        Err(err) => return fail_internal(ack, "call:createTransport", err),
    }
    if !room.has_peer(s.id.as_str()).await {
        return fail(ack, "call:join must be called before creating a transport");
    }

    let transport = match room.create_transport().await {
        Ok(transport) => transport,
        Err(err) => return fail_internal(ack, "call:createTransport", err),
    };

    // The frontend always creates its send transport before its recv
    // transport (see use-call.ts) - whichever of the two calls arrives
    // first for this peer becomes the send transport.
    let is_send = !room.has_send_transport(s.id.as_str()).await;

    let info = json!({
        "id": transport.id(),
        "iceParameters": transport.ice_parameters().clone(),
        "iceCandidates": transport.ice_candidates().clone(),
        "dtlsParameters": transport.dtls_parameters(),
    });

    room.set_transport(s.id.as_str(), transport, is_send).await;

    ok(ack, json!({ "transport": info }));
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectTransportReq {
    conversation_id: String,
    transport_id: TransportId,
    dtls_parameters: DtlsParameters,
}

#[tracing::instrument(
    name = "call:connectTransport",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id)
)]
async fn connect_transport(
    s: SocketRef,
    Data(req): Data<ConnectTransportReq>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let user_id = identity.user_id.to_string();
    let Some(room) = state.sfu().get(&req.conversation_id).await else {
        return fail(ack, "not in a call for this conversation");
    };
    match authorize_for_room(&state, &room, s.id.as_str(), &user_id, &req.conversation_id).await {
        Ok(true) => {}
        Ok(false) => return fail(ack, "forbidden"),
        Err(err) => return fail_internal(ack, "call:connectTransport", err),
    }
    let Some(transport) = room.find_transport(s.id.as_str(), req.transport_id).await else {
        return fail(ack, "unknown transport");
    };

    let result = transport
        .connect(WebRtcTransportRemoteParameters {
            dtls_parameters: req.dtls_parameters,
        })
        .await;

    match result {
        Ok(_) => ok(ack, json!({})),
        Err(err) => fail_internal(ack, "call:connectTransport", anyhow::anyhow!("{err}")),
    }
}

#[derive(Debug, Deserialize)]
struct ProduceAppData {
    source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProduceReq {
    conversation_id: String,
    transport_id: TransportId,
    kind: MediaKind,
    rtp_parameters: RtpParameters,
    app_data: ProduceAppData,
}

#[tracing::instrument(
    name = "call:produce",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id, kind = ?req.kind)
)]
async fn produce(
    s: SocketRef,
    Data(req): Data<ProduceReq>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let user_id = identity.user_id.to_string();
    let Some(source) = ProducerSource::parse(&req.app_data.source) else {
        return fail(ack, "invalid producer source");
    };

    let Some(room) = state.sfu().get(&req.conversation_id).await else {
        return fail(ack, "not in a call for this conversation");
    };
    match authorize_for_room(&state, &room, s.id.as_str(), &user_id, &req.conversation_id).await {
        Ok(true) => {}
        Ok(false) => return fail(ack, "forbidden"),
        Err(err) => return fail_internal(ack, "call:produce", err),
    }
    let Some(transport) = room.find_transport(s.id.as_str(), req.transport_id).await else {
        return fail(ack, "unknown transport");
    };

    let producer = match transport
        .produce(ProducerOptions::new(req.kind, req.rtp_parameters))
        .await
    {
        Ok(producer) => producer,
        Err(err) => return fail_internal(ack, "call:produce", anyhow::anyhow!("{err}")),
    };

    let producer_id = producer.id();
    room.add_producer(s.id.as_str(), producer, source).await;
    metrics::CALL_PRODUCERS_TOTAL.inc();
    crate::emf::emit_count("ws_sfu_call_producers_total", &[]);

    ok(ack, json!({ "producerId": producer_id }));

    let _ = s
        .to(format!("call:{}", req.conversation_id))
        .emit(
            "call:newProducer",
            &json!({
                "socketId": s.id.as_str(),
                "userId": user_id,
                "username": identity.username,
                "producerId": producer_id,
                "kind": req.kind,
                "appData": { "source": source },
                "paused": false,
            }),
        )
        .await;
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProducerScoped {
    conversation_id: String,
    producer_id: ProducerId,
}

/// Pausing the *server-side* mediasoup Producer (not just the client's local
/// track) stops it actually sending RTP - but unlike the plain Node.js
/// mediasoup-client + mediasoup-server pairing, this app's Consumer has no
/// built-in signaling connection to the server (every bit of signaling here
/// is our own Socket.IO events, see ws/mod.rs), so there is no automatic
/// "producerpause" notification for other participants to receive. The
/// explicit call:producerStateChanged broadcast below *is* that mechanism.
#[tracing::instrument(
    name = "call:pauseProducer",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id)
)]
async fn pause_producer(
    s: SocketRef,
    Data(req): Data<ProducerScoped>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    set_producer_paused(s, req, state, identity, ack, true).await;
}

#[tracing::instrument(
    name = "call:resumeProducer",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id)
)]
async fn resume_producer(
    s: SocketRef,
    Data(req): Data<ProducerScoped>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    set_producer_paused(s, req, state, identity, ack, false).await;
}

async fn set_producer_paused(
    s: SocketRef,
    req: ProducerScoped,
    state: AppState,
    identity: Identity,
    ack: AckSender,
    paused: bool,
) {
    let user_id = identity.user_id.to_string();
    let Some(room) = state.sfu().get(&req.conversation_id).await else {
        return fail(ack, "not in a call for this conversation");
    };
    match authorize_for_room(&state, &room, s.id.as_str(), &user_id, &req.conversation_id).await {
        Ok(true) => {}
        Ok(false) => return fail(ack, "forbidden"),
        Err(err) => return fail_internal(ack, "call:pauseProducer", err),
    }
    // Scoped to this socket's own producers - a peer can never pause
    // someone else's mic/camera by guessing their producer id.
    let Some(producer) = room.find_producer(s.id.as_str(), req.producer_id).await else {
        return fail(ack, "unknown producer");
    };
    let kind = producer.kind();
    let source = room.producer_source(req.producer_id).await;

    let result = if paused { producer.pause().await } else { producer.resume().await };
    match result {
        Ok(_) => ok(ack, json!({})),
        Err(err) => return fail_internal(ack, "call:pauseProducer", anyhow::anyhow!("{err}")),
    }

    let _ = s
        .to(format!("call:{}", req.conversation_id))
        .emit(
            "call:producerStateChanged",
            &json!({
                "socketId": s.id.as_str(),
                "producerId": req.producer_id,
                "kind": kind,
                "appData": { "source": source },
                "paused": paused,
            }),
        )
        .await;
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsumeReq {
    conversation_id: String,
    transport_id: TransportId,
    producer_id: ProducerId,
    rtp_capabilities: RtpCapabilities,
}

#[tracing::instrument(
    name = "call:consume",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id)
)]
async fn consume(
    s: SocketRef,
    Data(req): Data<ConsumeReq>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let user_id = identity.user_id.to_string();
    let Some(room) = state.sfu().get(&req.conversation_id).await else {
        return fail(ack, "not in a call for this conversation");
    };
    match authorize_for_room(&state, &room, s.id.as_str(), &user_id, &req.conversation_id).await {
        Ok(true) => {}
        Ok(false) => return fail(ack, "forbidden"),
        Err(err) => return fail_internal(ack, "call:consume", err),
    }
    let Some(transport) = room.find_transport(s.id.as_str(), req.transport_id).await else {
        return fail(ack, "unknown transport");
    };

    let mut options = ConsumerOptions::new(req.producer_id, req.rtp_capabilities);
    options.paused = true;

    let consumer = match transport.consume(options).await {
        Ok(consumer) => consumer,
        Err(err) => return fail_internal(ack, "call:consume", anyhow::anyhow!("{err}")),
    };

    let consumer_id = consumer.id();
    let kind = consumer.kind();
    let rtp_parameters = consumer.rtp_parameters().clone();
    let source = room.producer_source(req.producer_id).await;

    room.add_consumer(s.id.as_str(), consumer).await;

    ok(
        ack,
        json!({
            "consumer": {
                "id": consumer_id,
                "producerId": req.producer_id,
                "kind": kind,
                "rtpParameters": rtp_parameters,
                "appData": { "source": source },
            }
        }),
    );
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeConsumerReq {
    conversation_id: String,
    consumer_id: ConsumerId,
}

#[tracing::instrument(name = "call:resumeConsumer", skip_all, fields(conversation_id = %req.conversation_id))]
async fn resume_consumer(
    s: SocketRef,
    Data(req): Data<ResumeConsumerReq>,
    State(state): State<AppState>,
    ack: AckSender,
) {
    let Some(room) = state.sfu().get(&req.conversation_id).await else {
        return fail(ack, "not in a call for this conversation");
    };
    let Some(consumer) = room.find_consumer(s.id.as_str(), req.consumer_id).await else {
        return fail(ack, "unknown consumer");
    };

    match consumer.resume().await {
        Ok(_) => ok(ack, json!({})),
        Err(err) => fail_internal(ack, "call:resumeConsumer", anyhow::anyhow!("{err}")),
    }
}

/// Raise/lower hand is purely ephemeral - relayed to the room, never stored
/// on the peer - so a participant who joins mid-call doesn't see stale
/// raised hands from before they arrived. A deliberate scope cut, unlike
/// mute state, which late joiners do need to see correctly (see `paused` on
/// `ProducerInfo`).
#[tracing::instrument(
    name = "call:raiseHand",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id)
)]
async fn raise_hand(
    s: SocketRef,
    Data(req): Data<ConversationScoped>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    set_hand_raised(s, req, state, identity, ack, true).await;
}

#[tracing::instrument(
    name = "call:lowerHand",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id)
)]
async fn lower_hand(
    s: SocketRef,
    Data(req): Data<ConversationScoped>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    set_hand_raised(s, req, state, identity, ack, false).await;
}

async fn set_hand_raised(
    s: SocketRef,
    req: ConversationScoped,
    state: AppState,
    identity: Identity,
    ack: AckSender,
    raised: bool,
) {
    let user_id = identity.user_id.to_string();
    let Some(room) = state.sfu().get(&req.conversation_id).await else {
        return fail(ack, "not in a call for this conversation");
    };
    match authorize_for_room(&state, &room, s.id.as_str(), &user_id, &req.conversation_id).await {
        Ok(true) => {}
        Ok(false) => return fail(ack, "forbidden"),
        Err(err) => return fail_internal(ack, "call:raiseHand", err),
    }

    ok(ack, json!({}));

    let _ = s
        .to(format!("call:{}", req.conversation_id))
        .emit(
            "call:handStateChanged",
            &json!({
                "socketId": s.id.as_str(),
                "userId": user_id,
                "username": identity.username,
                "raised": raised,
            }),
        )
        .await;
}

/// Starting/stopping a recording requires both conversation membership *and*
/// the admin/moderator Cognito group - the one place in this file that
/// checks `identity.roles`. Regular participants never see this in the
/// frontend (no button rendered for them), but the server enforces it
/// independently since a hidden button is not a security boundary.
#[tracing::instrument(
    name = "call:startRecording",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id)
)]
async fn start_recording(
    s: SocketRef,
    Data(req): Data<ConversationScoped>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let user_id = identity.user_id.to_string();
    let Some(room) = state.sfu().get(&req.conversation_id).await else {
        return fail(ack, "not in a call for this conversation");
    };
    match authorize_for_room(&state, &room, s.id.as_str(), &user_id, &req.conversation_id).await {
        Ok(true) => {}
        Ok(false) => return fail(ack, "forbidden"),
        Err(err) => return fail_internal(ack, "call:startRecording", err),
    }
    if !identity.has_role("admin") && !identity.has_role("moderator") {
        return fail(ack, "forbidden");
    }

    match room.start_recording(&user_id, &identity.username).await {
        Ok(()) => {}
        Err(err) => return fail_internal(ack, "call:startRecording", err),
    }

    ok(ack, json!({}));

    let _ = s
        .to(format!("call:{}", req.conversation_id))
        .emit(
            "call:recordingStateChanged",
            &json!({ "recording": true, "startedByUsername": identity.username }),
        )
        .await;
}

#[tracing::instrument(
    name = "call:stopRecording",
    skip_all,
    fields(user_id = %identity.user_id, correlation_id = %identity.correlation_id, conversation_id = %req.conversation_id)
)]
async fn stop_recording(
    s: SocketRef,
    Data(req): Data<ConversationScoped>,
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    ack: AckSender,
) {
    let user_id = identity.user_id.to_string();
    let Some(room) = state.sfu().get(&req.conversation_id).await else {
        return fail(ack, "not in a call for this conversation");
    };
    match authorize_for_room(&state, &room, s.id.as_str(), &user_id, &req.conversation_id).await {
        Ok(true) => {}
        Ok(false) => return fail(ack, "forbidden"),
        Err(err) => return fail_internal(ack, "call:stopRecording", err),
    }
    if !identity.has_role("admin") && !identity.has_role("moderator") {
        return fail(ack, "forbidden");
    }
    let Some(session) = room.take_recording().await else {
        return fail(ack, "no recording is in progress");
    };

    ok(ack, json!({}));

    let _ = s
        .to(format!("call:{}", req.conversation_id))
        .emit("call:recordingStateChanged", &json!({ "recording": false }))
        .await;

    // Stopping ffmpeg gracefully and uploading to S3 takes real time (up to
    // the 10s SIGINT grace period per track, then an upload) - do it after
    // acking and broadcasting so participants aren't left waiting on it.
    let conversation_id = req.conversation_id.clone();
    tokio::spawn(async move {
        crate::sfu::recording::finish(&state, &conversation_id, session).await;
    });
}

#[tracing::instrument(name = "call:leave", skip_all, fields(conversation_id = %req.conversation_id))]
async fn leave(s: SocketRef, Data(req): Data<ConversationScoped>, State(state): State<AppState>) {
    cleanup::leave_room(&state, &s, &req.conversation_id).await;
}
