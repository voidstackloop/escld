use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use mediasoup::prelude::*;
use mediasoup::types::rtp_parameters::RtpCodecCapabilityFinalized;
use uuid::Uuid;

use crate::config::Config;
use crate::sfu::room::{ProducerInfo, ProducerSource};
use crate::state::AppState;

/// Loopback RTP hop between mediasoup and ffmpeg during recording - never
/// reachable off the host, unrelated to the WebRTC UDP range
/// (MEDIASOUP_RTC_MIN/MAX_PORT) which *does* need to be internet-reachable.
/// A plain wrapping counter is fine at this app's expected recording volume
/// (a rare moderator-triggered action, not a per-call default).
const RECORDING_PORT_RANGE_START: u16 = 51000;
const RECORDING_PORT_RANGE_END: u16 = 51999;
static NEXT_RECORDING_PORT: AtomicU16 = AtomicU16::new(RECORDING_PORT_RANGE_START);

fn next_recording_port() -> u16 {
    let port = NEXT_RECORDING_PORT.fetch_add(1, Ordering::Relaxed);
    if port > RECORDING_PORT_RANGE_END {
        NEXT_RECORDING_PORT.store(RECORDING_PORT_RANGE_START + 1, Ordering::Relaxed);
        RECORDING_PORT_RANGE_START
    } else {
        port
    }
}

/// Router capabilities, restated in the shape a Consumer wants. The two
/// types differ only in that a Router's codecs always carry a concrete
/// `preferred_payload_type` - there's no meaningful "negotiation" happening
/// here since we're consuming with the router's own full capability set,
/// which every producer in the room was necessarily created compatible with.
fn router_capabilities_as_consumer_capabilities(finalized: &RtpCapabilitiesFinalized) -> RtpCapabilities {
    RtpCapabilities {
        codecs: finalized
            .codecs
            .iter()
            .map(|codec| match codec.clone() {
                RtpCodecCapabilityFinalized::Audio {
                    mime_type,
                    preferred_payload_type,
                    clock_rate,
                    channels,
                    parameters,
                    rtcp_feedback,
                } => RtpCodecCapability::Audio {
                    mime_type,
                    preferred_payload_type: Some(preferred_payload_type),
                    clock_rate,
                    channels,
                    parameters,
                    rtcp_feedback,
                },
                RtpCodecCapabilityFinalized::Video {
                    mime_type,
                    preferred_payload_type,
                    clock_rate,
                    parameters,
                    rtcp_feedback,
                } => RtpCodecCapability::Video {
                    mime_type,
                    preferred_payload_type: Some(preferred_payload_type),
                    clock_rate,
                    parameters,
                    rtcp_feedback,
                },
            })
            .collect(),
        header_extensions: finalized.header_extensions.clone(),
    }
}

/// Minimal SDP describing one negotiated RTP stream, for ffmpeg's
/// `-protocol_whitelist file,udp,rtp` file-based RTP demuxer to read. Pulled
/// straight from the consumer's own negotiated codec, so payload type/clock
/// rate/channel count always match what mediasoup is actually sending.
fn build_sdp(kind: MediaKind, params: &RtpParameters, port: u16) -> anyhow::Result<String> {
    let codec = params
        .codecs
        .first()
        .ok_or_else(|| anyhow::anyhow!("consumer negotiated no codec"))?;

    let (mime, payload_type, clock_rate, channels) = match codec {
        RtpCodecParameters::Audio {
            mime_type,
            payload_type,
            clock_rate,
            channels,
            ..
        } => (mime_type.as_str(), *payload_type, clock_rate.get(), Some(channels.get())),
        RtpCodecParameters::Video {
            mime_type,
            payload_type,
            clock_rate,
            ..
        } => (mime_type.as_str(), *payload_type, clock_rate.get(), None),
    };
    let encoding_name = mime.split('/').nth(1).unwrap_or(mime);
    let media_type = match kind {
        MediaKind::Audio => "audio",
        MediaKind::Video => "video",
    };
    let channels_suffix = channels.map(|c| format!("/{c}")).unwrap_or_default();

    Ok(format!(
        "v=0\r\n\
         o=- 0 0 IN IP4 127.0.0.1\r\n\
         s=ws-sfu-recording\r\n\
         c=IN IP4 127.0.0.1\r\n\
         t=0 0\r\n\
         m={media_type} {port} RTP/AVP {payload_type}\r\n\
         a=rtpmap:{payload_type} {encoding_name}/{clock_rate}{channels_suffix}\r\n\
         a=recvonly\r\n"
    ))
}

struct RecordingTrack {
    _transport: PlainTransport,
    consumer: Consumer,
    child: tokio::process::Child,
    file_path: PathBuf,
    peer_user_id: String,
    source: ProducerSource,
}

/// One active (or just-finished) call recording. Holds every per-producer
/// ffmpeg process and mediasoup handle needed to stop it cleanly; created by
/// `start()` below and consumed by `finish()`.
pub struct RecordingSession {
    pub id: String,
    pub started_by_username: String,
    tracks: Vec<RecordingTrack>,
}

/// Starts recording every producer in `producers` - one PlainTransport +
/// Consumer + ffmpeg process per producer (see module docs on the module
/// for why this isn't mixed into a single file). A producer that fails to
/// set up (e.g. it closed mid-setup) is skipped with a warning rather than
/// aborting the whole recording.
pub async fn start(
    router: &Router,
    config: &Config,
    started_by_user_id: &str,
    started_by_username: &str,
    producers: Vec<ProducerInfo>,
) -> anyhow::Result<RecordingSession> {
    if config.recordings_bucket.is_none() {
        anyhow::bail!("no recordings bucket configured on this server");
    }
    if producers.is_empty() {
        anyhow::bail!("nobody in this call is producing audio or video yet");
    }

    let recording_id = Uuid::new_v4().to_string();
    tracing::info!(
        recording_id,
        started_by_user_id,
        started_by_username,
        producer_count = producers.len(),
        "starting call recording"
    );
    let dir = PathBuf::from(&config.recording_dir).join(&recording_id);
    tokio::fs::create_dir_all(&dir).await?;

    let consumer_capabilities = router_capabilities_as_consumer_capabilities(&router.rtp_capabilities());
    let loopback: IpAddr = "127.0.0.1".parse().expect("valid loopback address");

    let mut tracks = Vec::with_capacity(producers.len());
    for info in producers {
        match start_track(router, &consumer_capabilities, loopback, &dir, &info).await {
            Ok(track) => tracks.push(track),
            Err(err) => tracing::warn!(
                error = %err,
                producer_id = %info.producer_id,
                socket_id = %info.socket_id,
                "skipping producer that failed to start recording"
            ),
        }
    }

    if tracks.is_empty() {
        anyhow::bail!("failed to start recording for every producer in the call");
    }

    Ok(RecordingSession {
        id: recording_id,
        started_by_username: started_by_username.to_string(),
        tracks,
    })
}

async fn start_track(
    router: &Router,
    consumer_capabilities: &RtpCapabilities,
    loopback: IpAddr,
    dir: &Path,
    info: &ProducerInfo,
) -> anyhow::Result<RecordingTrack> {
    let listen_info = ListenInfo {
        protocol: Protocol::Udp,
        ip: loopback,
        announced_address: None,
        expose_internal_ip: false,
        port: None,
        port_range: None,
        flags: None,
        send_buffer_size: None,
        recv_buffer_size: None,
    };
    let transport = router
        .create_plain_transport(PlainTransportOptions::new(listen_info))
        .await
        .map_err(|err| anyhow::anyhow!("failed to create plain transport: {err}"))?;

    let recording_port = next_recording_port();
    transport
        .connect(PlainTransportRemoteParameters {
            ip: Some(loopback),
            port: Some(recording_port),
            rtcp_port: None,
            srtp_parameters: None,
        })
        .await
        .map_err(|err| anyhow::anyhow!("failed to connect plain transport: {err}"))?;

    let mut consumer_options = ConsumerOptions::new(info.producer_id, consumer_capabilities.clone());
    // Start paused, spawn ffmpeg to bind the port first, then resume - see
    // the sleep below. Consuming with paused:false would race ffmpeg's
    // startup and drop the video's first (and only immediate) keyframe.
    consumer_options.paused = true;
    let consumer = transport
        .consume(consumer_options)
        .await
        .map_err(|err| anyhow::anyhow!("failed to consume producer for recording: {err}"))?;

    let file_stem = format!("{}-{}", info.user_id, info.app_data.source.as_str());
    let sdp_path = dir.join(format!("{file_stem}.sdp"));
    let file_path = dir.join(format!("{file_stem}.webm"));

    let sdp = build_sdp(consumer.kind(), consumer.rtp_parameters(), recording_port)?;
    tokio::fs::write(&sdp_path, sdp).await?;

    let child = tokio::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-protocol_whitelist",
            "file,udp,rtp",
            "-analyzeduration",
            "10M",
            "-probesize",
            "10M",
            "-i",
        ])
        .arg(&sdp_path)
        .args(["-c", "copy"])
        .arg(&file_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| anyhow::anyhow!("failed to spawn ffmpeg: {err}"))?;

    // No handshake exists on this loopback UDP hop to confirm ffmpeg is
    // actually listening yet - a short fixed delay before unpausing is the
    // standard workaround for this exact mediasoup recording pattern.
    tokio::time::sleep(Duration::from_millis(1000)).await;

    consumer
        .resume()
        .await
        .map_err(|err| anyhow::anyhow!("failed to resume recording consumer: {err}"))?;
    if consumer.kind() == MediaKind::Video {
        // Otherwise ffmpeg waits for the producer's next natural keyframe
        // interval before it can decode anything.
        let _ = consumer.request_key_frame().await;
    }

    Ok(RecordingTrack {
        _transport: transport,
        consumer,
        child,
        file_path,
        peer_user_id: info.user_id.clone(),
        source: info.app_data.source,
    })
}

/// Stops every track in `session` (SIGINT so ffmpeg finalizes its container,
/// rather than SIGKILL which would leave a truncated file), uploads each
/// resulting file to the configured recordings bucket, and deletes the
/// local copy. Never shared back to call participants - only reachable by
/// whoever can read the private bucket directly (see infra/lib/recordings-stack.ts).
pub async fn finish(state: &AppState, conversation_id: &str, session: RecordingSession) {
    let Some(bucket) = state.config().recordings_bucket.clone() else {
        tracing::error!("recording finished but no recordings bucket is configured; files left on local disk");
        return;
    };

    let mut uploaded = 0usize;
    for track in session.tracks {
        stop_ffmpeg(track.child).await;
        drop(track.consumer);
        drop(track._transport);

        let key = format!(
            "recordings/{conversation_id}/{}/{}-{}.webm",
            session.id, track.peer_user_id, track.source.as_str()
        );
        match upload_and_cleanup(state, &bucket, &track.file_path, &key).await {
            Ok(()) => uploaded += 1,
            Err(err) => tracing::error!(
                error = %err,
                path = %track.file_path.display(),
                "failed to upload recording track"
            ),
        }
    }

    tracing::info!(
        conversation_id,
        recording_id = %session.id,
        tracks_uploaded = uploaded,
        "call recording finished"
    );
}

async fn stop_ffmpeg(mut child: tokio::process::Child) {
    if let Some(pid) = child.id() {
        let pid = nix::unistd::Pid::from_raw(pid as i32);
        if let Err(err) = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGINT) {
            tracing::warn!(error = %err, "failed to signal ffmpeg, killing it instead");
            let _ = child.kill().await;
            return;
        }
    }

    if tokio::time::timeout(Duration::from_secs(10), child.wait()).await.is_err() {
        tracing::warn!("ffmpeg did not exit after SIGINT within 10s, killing it");
        let _ = child.kill().await;
    }
}

async fn upload_and_cleanup(state: &AppState, bucket: &str, path: &Path, key: &str) -> anyhow::Result<()> {
    let body = aws_sdk_s3::primitives::ByteStream::from_path(path).await?;
    state
        .s3()
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(body)
        .content_type("video/webm")
        .send()
        .await?;
    let _ = tokio::fs::remove_file(path).await;
    Ok(())
}
