use std::sync::Arc;
use std::time::Duration;

use aws_sdk_s3::Client as S3Client;
use bytes::BytesMut;
use sqlx::PgPool;
use tokio::io::{AsyncRead, AsyncWrite, BufReader};
use tokio::net::TcpStream;
use uuid::Uuid;

use crate::amf::{AmfValue, AmfVersion};
use crate::config::Config;
use crate::flv;
use crate::hls::{self, HlsSink};
use crate::live_viewers;
use crate::s3_sync::{self, S3Sync};
use crate::store::postgres::{self, UserRow};
use crate::warehouse::WarehouseEventPublisher;

use super::chunk::ChunkReader;
use super::command;
use super::handshake;
use super::message::{
    RtmpMessage, MSG_TYPE_AUDIO, MSG_TYPE_COMMAND_AMF0, MSG_TYPE_COMMAND_AMF3, MSG_TYPE_DATA_AMF0,
    MSG_TYPE_DATA_AMF3, MSG_TYPE_VIDEO,
};
use super::writer;

/// One publishing stream's live state, held for as long as the encoder
/// keeps sending audio/video after a successful `publish` — absent before
/// that, and finalized (see `handle_connection`) the moment this
/// connection's read loop ends for any reason.
struct PublishState {
    user: UserRow,
    /// The backend Post this broadcast was announced as (see
    /// LiveStreamService on the Java side) — required to mark it ended when
    /// this connection drops (see `handle_connection`'s finalize block).
    post_id: Uuid,
    hls: HlsSink,
    /// `None` when no live delivery bucket is configured (see
    /// Config::live_bucket) — the stream is then reachable only via this
    /// instance's own local-disk `/hls/*` route.
    s3_sync: Option<S3Sync>,
    /// The FLV file header (see flv.rs) has to be written exactly once,
    /// before the first audio/video/data tag — this is `false` until that
    /// happens, since it can't be written eagerly at publish time (whether
    /// the stream ultimately carries audio, video, or both isn't known
    /// until the first real media message arrives).
    wrote_flv_header: bool,
}

/// Entry point for one accepted TCP connection — a single RTMP publish
/// session end to end: handshake, then command negotiation
/// (connect/createStream/publish), then a one-way stream of audio/video
/// into a live HLS output until the encoder disconnects. Never returns an
/// error to its own caller (main.rs's accept loop) — any failure at any
/// stage is logged here and simply ends this one connection.
pub async fn process(
    mut socket: TcpStream,
    pool: PgPool,
    config: Arc<Config>,
    s3: Arc<S3Client>,
    warehouse: Arc<WarehouseEventPublisher>,
) {
    let peer = socket.peer_addr().map(|a| a.to_string()).unwrap_or_default();
    if let Err(err) = handle_connection(&mut socket, &pool, &config, &s3, &warehouse).await {
        tracing::warn!(error = %err, peer, "rtmp connection ended");
    }
}

async fn handle_connection(
    socket: &mut TcpStream,
    pool: &PgPool,
    config: &Config,
    s3: &Arc<S3Client>,
    warehouse: &WarehouseEventPublisher,
) -> anyhow::Result<()> {
    handshake::perform(socket).await?;

    let (read_half, mut write_half) = socket.split();
    let mut reader = BufReader::new(read_half);
    let mut publish: Option<PublishState> = None;

    let result = session_loop(&mut reader, &mut write_half, pool, config, s3, &mut publish).await;

    if let Some(state) = publish {
        tracing::info!(user_id = %state.user.id, username = %state.user.username, "stream ended, finalizing HLS output");

        // Best-effort, matching every other cross-service reach on this
        // path: a missing/unreachable Redis just means peak_viewer_count
        // stays null, same as if no viewer ever pinged a heartbeat.
        let peak_viewer_count = match &config.redis_host {
            Some(host) => live_viewers::peak_viewer_count(host, config.redis_port, state.post_id).await,
            None => None,
        };

        // Marks the Post ended the moment the connection actually drops —
        // see mark_live_ended's own doc for why this is direct Postgres
        // access, not a callback into the backend. `Some(ended)` means this
        // really was the one that flipped LIVE->ENDED (not a race with the
        // app's own "End Stream" button already having done it) — only then
        // does publishing live.ended below make sense; the backend's own
        // publish already covers the other case.
        match postgres::mark_live_ended(pool, state.post_id, peak_viewer_count).await {
            Ok(Some(ended)) => {
                warehouse.publish_live_ended(state.post_id, &ended, peak_viewer_count).await;
            }
            Ok(None) => {}
            Err(err) => {
                tracing::warn!(error = %err, post_id = %state.post_id, "failed to mark live post ended in Postgres");
            }
        }

        let dir = state.hls.dir.clone();
        state.hls.stop().await;
        // Stopped after the local ffmpeg process, not before — this lets
        // the sync task's own final pass (see S3Sync::stop) pick up the
        // fully-finalized playlist ffmpeg just rewrote on exit.
        if let Some(sync) = state.s3_sync {
            sync.stop().await;
        }
        // Deleted after a delay, not immediately - a viewer's player may
        // still be mid-request for the final segment/playlist right as the
        // broadcaster disconnects (see hls.rs's cleanup doc).
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            hls::cleanup(&dir).await;
        });
    }

    result
}

async fn session_loop<R, W>(
    reader: &mut BufReader<R>,
    writer_half: &mut W,
    pool: &PgPool,
    config: &Config,
    s3: &Arc<S3Client>,
    publish: &mut Option<PublishState>,
) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut chunk_reader = ChunkReader::new();
    // Negotiated once, from the connect command's objectEncoding field (see
    // handle_command's "connect" arm) — governs every *response* this
    // connection sends from here on. Deliberately independent of how an
    // incoming message is decoded: that's always dispatched by the
    // message's own type_id (below), per the real RTMP spec — a client
    // could in principle declare objectEncoding=3 and still send an
    // individual command as AMF0, and decoding must still honor whatever
    // that message's own type_id says, not this negotiated state.
    let mut amf_version = AmfVersion::Amf0;

    loop {
        let message = chunk_reader.read_message(reader).await?;
        match message.type_id {
            MSG_TYPE_COMMAND_AMF0 | MSG_TYPE_COMMAND_AMF3 => {
                let decode_version = if message.type_id == MSG_TYPE_COMMAND_AMF3 { AmfVersion::Amf3 } else { AmfVersion::Amf0 };
                handle_command(writer_half, pool, config, s3, &message, decode_version, &mut amf_version, publish).await?;
            }
            MSG_TYPE_AUDIO | MSG_TYPE_VIDEO | MSG_TYPE_DATA_AMF0 | MSG_TYPE_DATA_AMF3 => {
                if let Some(state) = publish {
                    forward_to_hls(state, &message).await?;
                }
                // Silently dropped when nobody has published yet - a
                // misbehaving or malicious client sending media before a
                // successful `publish` has nowhere valid to go.
            }
            _ => {} // Every other message type is already handled inside ChunkReader itself.
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_command<W: AsyncWrite + Unpin>(
    w: &mut W,
    pool: &PgPool,
    config: &Config,
    s3: &Arc<S3Client>,
    message: &RtmpMessage,
    decode_version: AmfVersion,
    amf_version: &mut AmfVersion,
    publish: &mut Option<PublishState>,
) -> anyhow::Result<()> {
    let command = command::parse(decode_version, message.payload.clone())?;

    match command.name.as_str() {
        "connect" => {
            // objectEncoding: 0 or absent = AMF0 (the default), 3 = AMF3 —
            // the real spec mechanism for negotiating *response* encoding,
            // decided once here rather than mirrored per incoming message
            // (see session_loop's own doc comment on why those are
            // independent). Every send_* call below, and for the rest of
            // this connection, uses this value.
            if command.command_object.get("objectEncoding").and_then(AmfValue::as_f64) == Some(3.0) {
                *amf_version = AmfVersion::Amf3;
            }
            // The three messages every real client waits for, in this
            // order, before it considers the connection ready to proceed —
            // see writer.rs's own doc comments on each.
            writer::write_window_ack_size(w, 5_000_000).await?;
            writer::write_set_peer_bandwidth(w, 5_000_000).await?;
            writer::write_stream_begin(w, 0).await?;
            command::send_connect_success(w, *amf_version, command.transaction_id).await?;
        }
        "createStream" => {
            // Always the same fixed id - see PublishState's doc and
            // send_create_stream_success's own comment on why a real
            // per-call allocation isn't needed here.
            command::send_create_stream_success(w, *amf_version, command.transaction_id, 1).await?;
        }
        "publish" => {
            let stream_name = command.args.first().and_then(|v| v.as_str()).unwrap_or_default();
            match start_publish(pool, config, s3, stream_name).await {
                Ok(state) => {
                    tracing::info!(user_id = %state.user.id, username = %state.user.username, "stream published");
                    *publish = Some(state);
                    command::send_publish_status(
                        w,
                        *amf_version,
                        message.stream_id,
                        "status",
                        "NetStream.Publish.Start",
                        "Publish succeeded.",
                    )
                    .await?;
                }
                Err(err) => {
                    tracing::warn!(error = %err, stream_name, "rejected publish");
                    command::send_publish_status(
                        w,
                        *amf_version,
                        message.stream_id,
                        "error",
                        "NetStream.Publish.BadName",
                        "Invalid or unknown stream key.",
                    )
                    .await?;
                    // The publish attempt failed outright - not worth
                    // keeping the connection open waiting for a retry the
                    // client would send on a fresh connection anyway (every
                    // encoder this server targets reconnects from scratch
                    // after a rejected publish, not on the same socket).
                    anyhow::bail!("rejected publish for stream_name={stream_name:?}: {err}");
                }
            }
        }
        // releaseStream / FCPublish / FCUnpublish / etc. - extra commands
        // OBS and other encoders send around the publish handshake that
        // don't need any response for a publish-only server; silently
        // accepting without answering is standard behavior real servers
        // exhibit for these too.
        _ => {}
    }
    Ok(())
}

async fn start_publish(
    pool: &PgPool,
    config: &Config,
    s3: &Arc<S3Client>,
    stream_name: &str,
) -> anyhow::Result<PublishState> {
    let stream_key = Uuid::parse_str(stream_name)
        .map_err(|_| anyhow::anyhow!("publish name {stream_name:?} is not a valid stream key"))?;
    let user = postgres::find_by_stream_key(pool, stream_key)
        .await?
        .ok_or_else(|| anyhow::anyhow!("unknown or revoked stream key"))?;

    // Requires the app's own "go live" flow (POST /api/v1/live/streams) to
    // have run first — a stream key alone is not enough to publish. This is
    // what makes title/description a real prerequisite rather than an
    // optional afterthought: there is no path for an encoder to start
    // pushing video without a title already on record.
    let post_id = postgres::find_live_post_id_for_user(pool, user.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("no announced live stream for this user — go live from the app first"))?;

    let hls = hls::start(config, &stream_key.to_string()).await?;

    // Best-effort: a failed flip to READY leaves the frontend showing its
    // PROCESSING placeholder even though the stream is actually live — not
    // ideal, but never worth refusing a publish that otherwise succeeded.
    if let Err(err) = postgres::mark_media_ready(pool, post_id).await {
        tracing::warn!(error = %err, post_id = %post_id, "failed to mark live post's media as ready");
    }

    let s3_sync = config.live_bucket.clone().map(|bucket| {
        s3_sync::start(
            Arc::clone(s3),
            bucket,
            config.live_bucket_prefix.clone(),
            hls.dir.clone(),
            stream_key.to_string(),
            Duration::from_millis(config.s3_sync_poll_ms),
        )
    });

    Ok(PublishState {
        user,
        post_id,
        hls,
        s3_sync,
        wrote_flv_header: false,
    })
}

async fn forward_to_hls(state: &mut PublishState, message: &RtmpMessage) -> anyhow::Result<()> {
    let mut buf = BytesMut::new();
    if !state.wrote_flv_header {
        // Declaring both present regardless of which one this particular
        // message carries - by the time any single audio/video/data
        // message has arrived, ffmpeg's own FLV demuxer determines the
        // stream's real composition from the tags themselves, not from
        // this header's flags (which are only ever a hint).
        flv::write_header(&mut buf, true, true);
        state.wrote_flv_header = true;
    }

    let tag_type = match message.type_id {
        MSG_TYPE_AUDIO => flv::TAG_TYPE_AUDIO,
        MSG_TYPE_VIDEO => flv::TAG_TYPE_VIDEO,
        _ => flv::TAG_TYPE_SCRIPT_DATA,
    };
    flv::write_tag(&mut buf, tag_type, message.timestamp, &message.payload);

    state.hls.write(&buf).await
}
