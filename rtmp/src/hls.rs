use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};

use crate::config::Config;

/// One live stream's ffmpeg process, remuxing the FLV byte stream this
/// server reconstructs from RTMP (see flv.rs) into a live HLS playlist +
/// segments on local disk. ffmpeg does the actual audio/video demux/mux —
/// this server's own job stops at "produce a valid FLV stream and hand it
/// to a subprocess", the same "small explicit adapter over a well-solved
/// hard problem" call already made for worker/'s VOD transcode
/// (worker/src/ffmpeg.ts) and ws-sfu's call recording
/// (ws-sfu/src/sfu/recording.rs) — writing a hand-rolled H.264/AAC-aware
/// live segmenter from raw RTMP chunks would be reimplementing ffmpeg
/// itself for no benefit.
pub struct HlsSink {
    child: Child,
    stdin: ChildStdin,
    pub dir: PathBuf,
}

/// Starts ffmpeg reading FLV from stdin (`-f flv -i pipe:0`, not a real
/// file — this server never buffers the whole stream to disk first) and
/// writing an fMP4-segmented live HLS playlist under
/// `<hls_dir>/<stream_key>/`. `-c copy`: this server passes through
/// whatever codec the encoder itself sent (OBS defaults to H.264/AAC,
/// universally HLS-compatible) rather than re-encoding, which would need
/// real CPU budget per concurrent stream this pass doesn't attempt to size.
///
/// **No partial-segment (LL-HLS `EXT-X-PART`) output here** — confirmed
/// directly against a real `ffmpeg -h muxer=hls` run (both the locally
/// available 7.0.2 build and, by inspection, every mainline ffmpeg release)
/// that the `hls` muxer's option surface has no `-hls_part_time` or any
/// other partial-segment mechanism at all; this isn't a version gap to
/// close by upgrading, it simply isn't implemented in mainline ffmpeg.
/// Genuine sub-2s LL-HLS would need a different segmenter entirely (a
/// patched ffmpeg build, or a purpose-built one) — out of scope here. What
/// this config *can* still do, and does: short full segments
/// (`hls_segment_seconds`, real cuts still wait for the next keyframe under
/// `-c copy`) plus fast upload polling (`s3_sync.rs`) plus a tight
/// CloudFront TTL (`infra/lib/media-stack.ts`) — a real, meaningfully lower
/// latency than the original 4s/6-segment defaults, just not spec LL-HLS.
pub async fn start(config: &Config, stream_key: &str) -> anyhow::Result<HlsSink> {
    let dir = PathBuf::from(&config.hls_dir).join(stream_key);
    tokio::fs::create_dir_all(&dir).await?;

    let playlist_path = dir.join("live.m3u8");
    let segment_pattern = dir.join("segment_%05d.m4s");

    let mut child = tokio::process::Command::new("ffmpeg")
        .args(["-y", "-f", "flv", "-i", "pipe:0"])
        .args(["-c", "copy"])
        .args(["-f", "hls"])
        .args(["-hls_time", &config.hls_segment_seconds.to_string()])
        .args(["-hls_list_size", &config.hls_playlist_size.to_string()])
        // delete_segments: a live broadcast has no fixed end, so without
        // this ffmpeg would keep every segment on disk forever instead of
        // only the window the playlist actually references.
        .args(["-hls_flags", "delete_segments+independent_segments"])
        .args(["-hls_segment_type", "fmp4"])
        // ffmpeg resolves this filename relative to the playlist's own
        // directory (by string-concatenating dirname + this value, not a
        // real path join) — passing the already-absolute init_segment_path
        // here doubled the directory prefix and made ffmpeg fail to open
        // the init segment at all. A bare basename is what ffmpeg expects;
        // -hls_segment_filename below is the documented exception that
        // does accept a full absolute path.
        .arg("-hls_fmp4_init_filename")
        .arg("init.mp4")
        .arg("-hls_segment_filename")
        .arg(&segment_pattern)
        .arg(&playlist_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| anyhow::anyhow!("failed to spawn ffmpeg: {err}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("ffmpeg child has no stdin handle"))?;

    Ok(HlsSink { child, stdin, dir })
}

impl HlsSink {
    pub async fn write(&mut self, bytes: &[u8]) -> anyhow::Result<()> {
        self.stdin.write_all(bytes).await?;
        Ok(())
    }

    /// SIGINT, not SIGKILL — gives ffmpeg the chance to finalize the last
    /// segment and rewrite the playlist with the `#EXT-X-ENDLIST` tag real
    /// HLS players use to know the stream has actually ended (rather than
    /// just stalled), the same reasoning as ws-sfu's call-recording stop
    /// path (ws-sfu/src/sfu/recording.rs's `stop_ffmpeg`).
    pub async fn stop(mut self) {
        drop(self.stdin); // EOF on ffmpeg's stdin — it may exit on its own from this alone.

        if let Some(pid) = self.child.id() {
            let pid = nix::unistd::Pid::from_raw(pid as i32);
            if let Err(err) = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGINT) {
                tracing::warn!(error = %err, "failed to signal ffmpeg, killing it instead");
                let _ = self.child.kill().await;
                return;
            }
        }

        if tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await.is_err() {
            tracing::warn!("ffmpeg did not exit after SIGINT within 10s, killing it");
            let _ = self.child.kill().await;
        }
    }
}

/// Deletes a finished stream's local HLS output — called some time after
/// `stop()`, not immediately, so a viewer whose player is mid-request for
/// the last segment doesn't hit a 404 the instant the broadcaster stops.
/// This pass writes live segments straight to local disk with no S3/
/// CloudFront upload (see the plan doc's own Phase 2 note) — cleanup is
/// still real and needed even so, or a long-running server accumulates
/// every past stream's segments forever.
pub async fn cleanup(dir: &Path) {
    if let Err(err) = tokio::fs::remove_dir_all(dir).await {
        tracing::warn!(error = %err, dir = %dir.display(), "failed to clean up local HLS output");
    }
}
