pub mod cleanup;
pub mod recording;
pub mod room;

use std::collections::HashMap;
use std::num::{NonZeroU32, NonZeroU8};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use mediasoup::prelude::*;
use tokio::sync::RwLock;

use crate::config::Config;
use crate::metrics;
use room::Room;

/// Codecs this SFU accepts from clients - Opus for audio and VP8 for video,
/// the universally-supported, license-free default every target browser
/// negotiates without extra configuration.
pub fn media_codecs() -> Vec<RtpCodecCapability> {
    vec![
        RtpCodecCapability::Audio {
            mime_type: MimeTypeAudio::Opus,
            preferred_payload_type: None,
            clock_rate: NonZeroU32::new(48000).unwrap(),
            channels: NonZeroU8::new(2).unwrap(),
            parameters: RtpCodecParametersParameters::from([("useinbandfec", 1_u32.into())]),
            rtcp_feedback: vec![RtcpFeedback::TransportCc],
        },
        RtpCodecCapability::Video {
            mime_type: MimeTypeVideo::Vp8,
            preferred_payload_type: None,
            clock_rate: NonZeroU32::new(90000).unwrap(),
            parameters: RtpCodecParametersParameters::default(),
            rtcp_feedback: vec![
                RtcpFeedback::Nack,
                RtcpFeedback::NackPli,
                RtcpFeedback::CcmFir,
                RtcpFeedback::GoogRemb,
                RtcpFeedback::TransportCc,
            ],
        },
    ]
}

/// Fixed set of mediasoup worker (OS) processes created once at startup,
/// handed out round-robin as rooms are created. `MEDIASOUP_WORKER_COUNT`
/// controls the size - two is plenty for local dev, matching the comment on
/// that env var in docker-compose.yaml.
struct WorkerPool {
    _manager: WorkerManager,
    workers: Vec<Worker>,
    next: AtomicUsize,
}

impl WorkerPool {
    /// `rtc_port_range` defaults (library-wide) to a broad 10000..=59999 -
    /// left as-is, a worker would reserve that whole range even though every
    /// transport's own `ListenInfo.port_range` (see Room::create_transport)
    /// only ever requests the tight `MEDIASOUP_RTC_MIN_PORT..MAX_PORT` slice
    /// actually opened in the security group/firewall. Matching the two
    /// explicitly means the worker never reserves ports that were never
    /// exposed to clients in the first place.
    async fn new(count: usize, rtc_port_range: std::ops::RangeInclusive<u16>) -> anyhow::Result<Self> {
        let manager = WorkerManager::new();
        let mut workers = Vec::with_capacity(count);
        for _ in 0..count {
            // WorkerSettings is #[non_exhaustive] (mediasoup may add fields
            // in a semver-compatible release) - mutate the default instance
            // rather than a struct-update literal, which that attribute
            // blocks from outside the crate.
            let mut settings = WorkerSettings::default();
            settings.rtc_port_range = rtc_port_range.clone();
            let worker = manager
                .create_worker(settings)
                .await
                .map_err(|err| anyhow::anyhow!("failed to create mediasoup worker: {err}"))?;
            workers.push(worker);
        }
        Ok(Self {
            _manager: manager,
            workers,
            next: AtomicUsize::new(0),
        })
    }

    fn next_worker(&self) -> &Worker {
        let i = self.next.fetch_add(1, Ordering::Relaxed) % self.workers.len();
        &self.workers[i]
    }
}

/// `conversationId -> Room`, created lazily on the first `call:join` for
/// that conversation and torn down once its last peer leaves.
pub struct RoomRegistry {
    config: Arc<Config>,
    workers: WorkerPool,
    rooms: RwLock<HashMap<String, Arc<Room>>>,
}

impl RoomRegistry {
    pub async fn new(config: Arc<Config>) -> anyhow::Result<Self> {
        let workers = WorkerPool::new(
            config.mediasoup_worker_count,
            config.mediasoup_rtc_min_port..=config.mediasoup_rtc_max_port,
        )
        .await?;
        Ok(Self {
            config,
            workers,
            rooms: RwLock::new(HashMap::new()),
        })
    }

    pub async fn get(&self, conversation_id: &str) -> Option<Arc<Room>> {
        self.rooms.read().await.get(conversation_id).cloned()
    }

    pub async fn get_or_create(&self, conversation_id: &str) -> anyhow::Result<Arc<Room>> {
        if let Some(room) = self.rooms.read().await.get(conversation_id) {
            return Ok(Arc::clone(room));
        }

        // Router creation (a real async call into the mediasoup worker
        // thread, not free) deliberately happens *before* taking the write
        // lock - holding a single process-wide lock across it would
        // serialize call:join for every unrelated conversation on whichever
        // one happens to be creating its room. The second double-check
        // below handles the case where another task raced us and already
        // inserted a room while we were awaiting create_router - in that
        // rare case the router we just built is simply dropped.
        let worker = self.workers.next_worker();
        let router = worker
            .create_router(RouterOptions::new(media_codecs()))
            .await
            .map_err(|err| anyhow::anyhow!("failed to create router: {err}"))?;
        let room = Arc::new(Room::new(router, Arc::clone(&self.config)));

        let mut rooms = self.rooms.write().await;
        if let Some(existing) = rooms.get(conversation_id) {
            tracing::debug!(
                conversation_id,
                "lost the race to create this room's router; dropping the redundant one"
            );
            return Ok(Arc::clone(existing));
        }
        rooms.insert(conversation_id.to_string(), Arc::clone(&room));
        metrics::ROOMS_ACTIVE.set(rooms.len() as i64);
        crate::emf::emit_gauge("ws_sfu_call_rooms_active", rooms.len() as f64);
        Ok(room)
    }

    pub async fn room_ids(&self) -> Vec<String> {
        self.rooms.read().await.keys().cloned().collect()
    }

    /// Called after a peer leaves - drops the room (and its Router) once
    /// nobody is left in it.
    pub async fn remove_if_empty(&self, conversation_id: &str) {
        let mut rooms = self.rooms.write().await;
        let is_empty = match rooms.get(conversation_id) {
            Some(room) => room.is_empty().await,
            None => return,
        };
        if is_empty {
            rooms.remove(conversation_id);
            metrics::ROOMS_ACTIVE.set(rooms.len() as i64);
            crate::emf::emit_gauge("ws_sfu_call_rooms_active", rooms.len() as f64);
        }
    }
}
