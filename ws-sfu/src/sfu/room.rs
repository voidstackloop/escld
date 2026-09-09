use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use mediasoup::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::config::Config;
use crate::sfu::recording::RecordingSession;

/// Mirrors the frontend's `appData.source` on a producer - tracked in our
/// own struct rather than fighting mediasoup's generic `AppData` typing, so
/// the exact JSON shape sent back to the client stays under our control.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProducerSource {
    Mic,
    Camera,
    Screen,
}

impl ProducerSource {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "mic" => Some(Self::Mic),
            "camera" => Some(Self::Camera),
            "screen" => Some(Self::Screen),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Mic => "mic",
            Self::Camera => "camera",
            Self::Screen => "screen",
        }
    }
}

struct PeerProducer {
    producer: Producer,
    source: ProducerSource,
}

struct Peer {
    user_id: String,
    username: String,
    send_transport: Option<WebRtcTransport>,
    recv_transport: Option<WebRtcTransport>,
    producers: HashMap<ProducerId, PeerProducer>,
    consumers: HashMap<ConsumerId, Consumer>,
    /// When this peer's conversation membership was last confirmed against
    /// DynamoDB - see Room::is_recently_authorized/mark_authorized, used by
    /// ws/call.rs to avoid re-fetching the conversation on every single
    /// call:* event a peer sends.
    authorized_at: std::time::Instant,
}

impl Peer {
    fn new(user_id: String, username: String) -> Self {
        Self {
            user_id,
            username,
            send_transport: None,
            recv_transport: None,
            producers: HashMap::new(),
            consumers: HashMap::new(),
            authorized_at: std::time::Instant::now(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProducerAppData {
    pub source: ProducerSource,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProducerInfo {
    pub socket_id: String,
    pub user_id: String,
    pub username: String,
    pub producer_id: ProducerId,
    pub kind: MediaKind,
    pub app_data: ProducerAppData,
    /// So a peer who joins *after* someone already muted still sees the
    /// correct mic/camera-off badge immediately, not just on the next
    /// state change (see call:producerStateChanged).
    pub paused: bool,
}

/// One mediasoup call room, keyed by conversationId in `RoomRegistry`. Owns
/// a single `Router` (created on one worker from the pool) plus every
/// currently-joined peer's transports/producers/consumers.
pub struct Room {
    router: Router,
    config: Arc<Config>,
    /// A room's set of supported codecs never changes after the router is
    /// created - computed once here instead of cloning the full codec/header
    /// -extension list out of the router on every single call:join.
    rtp_capabilities: Arc<RtpCapabilitiesFinalized>,
    peers: RwLock<HashMap<String, Peer>>,
    /// At most one recording per room at a time - see sfu/recording.rs.
    recording: RwLock<Option<RecordingSession>>,
    /// A lock-free reservation flag, separate from `recording` itself, so
    /// `start_recording` never has to hold `recording`'s write lock across
    /// the multi-second async work (per-producer plain transports, ffmpeg
    /// spawn, a deliberate per-track settle delay) that building a session
    /// actually takes - see start_recording's own comment for why that
    /// matters.
    recording_starting: AtomicBool,
}

impl Room {
    pub fn new(router: Router, config: Arc<Config>) -> Self {
        let rtp_capabilities = Arc::new(router.rtp_capabilities().clone());
        Self {
            router,
            config,
            rtp_capabilities,
            peers: RwLock::new(HashMap::new()),
            recording: RwLock::new(None),
            recording_starting: AtomicBool::new(false),
        }
    }

    pub fn rtp_capabilities(&self) -> Arc<RtpCapabilitiesFinalized> {
        Arc::clone(&self.rtp_capabilities)
    }

    pub async fn is_empty(&self) -> bool {
        self.peers.read().await.is_empty()
    }

    pub async fn ensure_peer(&self, socket_id: &str, user_id: &str, username: &str) {
        let mut peers = self.peers.write().await;
        peers
            .entry(socket_id.to_string())
            .or_insert_with(|| Peer::new(user_id.to_string(), username.to_string()));
    }

    /// True if this socket's conversation membership was confirmed against
    /// DynamoDB within `ttl` - lets ws/call.rs skip a fresh GetItem on
    /// every call:* event (mute toggles and hand-raises especially) while
    /// still re-checking periodically, so a participant removed from the
    /// conversation mid-call eventually loses access rather than never.
    pub async fn is_recently_authorized(&self, socket_id: &str, ttl: std::time::Duration) -> bool {
        self.peers
            .read()
            .await
            .get(socket_id)
            .is_some_and(|peer| peer.authorized_at.elapsed() < ttl)
    }

    pub async fn mark_authorized(&self, socket_id: &str) {
        if let Some(peer) = self.peers.write().await.get_mut(socket_id) {
            peer.authorized_at = std::time::Instant::now();
        }
    }

    /// Builds a fresh UDP `WebRtcTransport` for one direction of one peer's
    /// media. Listen config comes straight from `MEDIASOUP_LISTEN_IP` /
    /// `MEDIASOUP_ANNOUNCED_IP` / `MEDIASOUP_RTC_MIN_PORT` /
    /// `MEDIASOUP_RTC_MAX_PORT`, matching docker-compose exactly.
    pub async fn create_transport(&self) -> anyhow::Result<WebRtcTransport> {
        let listen_ip: IpAddr = self.config.mediasoup_listen_ip.parse()?;

        let listen_info = ListenInfo {
            protocol: Protocol::Udp,
            ip: listen_ip,
            announced_address: Some(self.config.mediasoup_announced_ip.clone()),
            expose_internal_ip: false,
            port: None,
            port_range: Some(self.config.mediasoup_rtc_min_port..=self.config.mediasoup_rtc_max_port),
            flags: None,
            send_buffer_size: None,
            recv_buffer_size: None,
        };

        let options = WebRtcTransportOptions::new(WebRtcTransportListenInfos::new(listen_info));
        self.router
            .create_webrtc_transport(options)
            .await
            .map_err(|err| anyhow::anyhow!("failed to create transport: {err}"))
    }

    pub async fn has_peer(&self, socket_id: &str) -> bool {
        self.peers.read().await.contains_key(socket_id)
    }

    pub async fn has_send_transport(&self, socket_id: &str) -> bool {
        self.peers
            .read()
            .await
            .get(socket_id)
            .map(|peer| peer.send_transport.is_some())
            .unwrap_or(false)
    }

    pub async fn set_transport(&self, socket_id: &str, transport: WebRtcTransport, is_send: bool) {
        if let Some(peer) = self.peers.write().await.get_mut(socket_id) {
            if is_send {
                peer.send_transport = Some(transport);
            } else {
                peer.recv_transport = Some(transport);
            }
        }
    }

    pub async fn find_transport(&self, socket_id: &str, transport_id: TransportId) -> Option<WebRtcTransport> {
        let peers = self.peers.read().await;
        let peer = peers.get(socket_id)?;
        for transport in [&peer.send_transport, &peer.recv_transport].into_iter().flatten() {
            if transport.id() == transport_id {
                return Some(transport.clone());
            }
        }
        None
    }

    pub async fn add_producer(&self, socket_id: &str, producer: Producer, source: ProducerSource) {
        if let Some(peer) = self.peers.write().await.get_mut(socket_id) {
            peer.producers.insert(producer.id(), PeerProducer { producer, source });
        }
    }

    pub async fn producer_source(&self, producer_id: ProducerId) -> Option<ProducerSource> {
        self.peers
            .read()
            .await
            .values()
            .find_map(|peer| peer.producers.get(&producer_id).map(|p| p.source))
    }

    /// Scoped to `socket_id` so a peer can only pause/resume their own
    /// producer, never another participant's - see call:pauseProducer.
    pub async fn find_producer(&self, socket_id: &str, producer_id: ProducerId) -> Option<Producer> {
        self.peers
            .read()
            .await
            .get(socket_id)?
            .producers
            .get(&producer_id)
            .map(|p| p.producer.clone())
    }

    pub async fn add_consumer(&self, socket_id: &str, consumer: Consumer) {
        if let Some(peer) = self.peers.write().await.get_mut(socket_id) {
            peer.consumers.insert(consumer.id(), consumer);
        }
    }

    pub async fn find_consumer(&self, socket_id: &str, consumer_id: ConsumerId) -> Option<Consumer> {
        self.peers
            .read()
            .await
            .get(socket_id)?
            .consumers
            .get(&consumer_id)
            .cloned()
    }

    /// Every producer currently in the room except `exclude_socket_id`'s own
    /// - used both for `call:join`'s `otherProducers` and could be reused
    /// for a future "who's already here" query.
    pub async fn producer_infos(&self, exclude_socket_id: &str) -> Vec<ProducerInfo> {
        self.all_producer_infos()
            .await
            .into_iter()
            .filter(|info| info.socket_id != exclude_socket_id)
            .collect()
    }

    /// Every producer currently in the room, from every peer - used to seed
    /// a new recording with whoever is already in the call (see
    /// sfu/recording.rs; tracks added after recording starts are not
    /// auto-included, a deliberate scope cut).
    pub async fn all_producer_infos(&self) -> Vec<ProducerInfo> {
        self.peers
            .read()
            .await
            .iter()
            .flat_map(|(socket_id, peer)| {
                peer.producers.values().map(move |p| ProducerInfo {
                    socket_id: socket_id.clone(),
                    user_id: peer.user_id.clone(),
                    username: peer.username.clone(),
                    producer_id: p.producer.id(),
                    kind: p.producer.kind(),
                    app_data: ProducerAppData { source: p.source },
                    paused: p.producer.paused(),
                })
            })
            .collect()
    }

    /// Username of whoever started the active recording, if any - sent to
    /// late joiners via `call:join` so their UI shows the indicator badge
    /// immediately instead of waiting for the next state change.
    pub async fn recording_started_by(&self) -> Option<String> {
        self.recording
            .read()
            .await
            .as_ref()
            .map(|session| session.started_by_username.clone())
    }

    /// Starts recording every producer currently in the room. Fails if a
    /// recording is already active or if the server has no recordings
    /// bucket configured (see Config::recordings_bucket).
    ///
    /// Deliberately does *not* hold `recording`'s write lock across the
    /// actual work - `recording::start` opens a plain transport, connects,
    /// and consumes per producer, plus a real per-track settle sleep, which
    /// on a multi-producer room can take several seconds. Holding the write
    /// lock that whole time would block every late-joiner's
    /// `recording_started_by` read and any concurrent `stop_recording`
    /// (both needing this room's lock) for the entire window. Mutual
    /// exclusion between concurrent `start_recording` calls is instead
    /// provided by the lock-free `recording_starting` flag, reserved before
    /// any async work begins - the flag is released only *after* the
    /// resulting session (or the error) has been fully committed below, not
    /// right after the async work finishes, so a second concurrent caller
    /// can never observe a window where the reservation is free but the
    /// winning session hasn't been stored yet (which would let it start a
    /// second, untracked recording that's never reachable via
    /// stop_recording/take_recording).
    pub async fn start_recording(
        &self,
        started_by_user_id: &str,
        started_by_username: &str,
    ) -> anyhow::Result<()> {
        if self.recording.read().await.is_some() {
            anyhow::bail!("a recording is already in progress for this call");
        }
        if self.recording_starting.swap(true, Ordering::AcqRel) {
            anyhow::bail!("a recording is already being started for this call");
        }

        let producers = self.all_producer_infos().await;
        let result = crate::sfu::recording::start(
            &self.router,
            &self.config,
            started_by_user_id,
            started_by_username,
            producers,
        )
        .await;

        let outcome = match result {
            Ok(session) => {
                *self.recording.write().await = Some(session);
                Ok(())
            }
            Err(err) => Err(err),
        };
        self.recording_starting.store(false, Ordering::Release);
        outcome
    }

    /// Removes and returns the active recording, if any, so the caller can
    /// finish it (stop ffmpeg, upload to S3) outside of this lock.
    pub async fn take_recording(&self) -> Option<RecordingSession> {
        self.recording.write().await.take()
    }

    /// Removes the peer, dropping its transports/producers/consumers - the
    /// last reference to each mediasoup handle going out of scope here is
    /// what tears down the underlying resources server-side. Returns
    /// `false` if the peer was already gone (idempotent cleanup).
    pub async fn remove_peer(&self, socket_id: &str) -> bool {
        self.peers.write().await.remove(socket_id).is_some()
    }
}
