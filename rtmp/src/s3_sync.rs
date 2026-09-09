use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use aws_sdk_s3::Client;
use aws_sdk_s3::primitives::ByteStream;
use tokio::sync::watch;

/// Polls a live HLS output directory (see hls.rs) and uploads new/changed
/// files to S3 under `<prefix>/<stream_key>/`, so a stream is watchable
/// through CloudFront (see infra/lib/media-stack.ts's live-manifest cache
/// behavior) rather than only from this one instance's own local-disk
/// `/hls/*` route. A poll loop, not filesystem notifications (inotify etc.)
/// — ffmpeg writes these files directly and this app has no existing
/// precedent for a filesystem-watcher dependency; the poll interval is
/// configurable (`Config::s3_sync_poll_ms`, default 100ms) specifically
/// because it's one of the few real levers left for cutting delivered
/// latency once mainline ffmpeg's lack of LL-HLS partial-segment support
/// rules out the other one (see hls.rs's own doc) — at that interval
/// against a handful of small files per stream, the request overhead stays
/// negligible even so.
pub struct S3Sync {
    stop_tx: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

const MANIFEST_FILENAME: &str = "live.m3u8";

/// Starts the background sync task. The caller is responsible for calling
/// `stop()` when the stream ends — dropping this value instead would abort
/// the task immediately and skip the final sync pass `stop()` performs.
pub fn start(client: Arc<Client>, bucket: String, prefix: String, dir: PathBuf, stream_key: String, poll_interval: Duration) -> S3Sync {
    let (stop_tx, mut stop_rx) = watch::channel(false);

    let handle = tokio::spawn(async move {
        // Segments are immutable once ffmpeg finishes writing them (unlike
        // the manifest, which changes on every tick) — tracking uploaded
        // filenames here means each is ever sent to S3 exactly once.
        let mut uploaded: HashSet<String> = HashSet::new();

        loop {
            sync_once(&client, &bucket, &prefix, &dir, &stream_key, &mut uploaded).await;

            tokio::select! {
                _ = tokio::time::sleep(poll_interval) => {}
                _ = stop_rx.changed() => break,
            }
        }

        // One last pass so the fully-finalized playlist (ffmpeg rewrites it
        // with #EXT-X-ENDLIST right before exiting, after SIGINT — see
        // hls.rs's stop()) and any final segment actually reach S3, instead
        // of a viewer's next manifest fetch seeing a stale, never-ended one.
        sync_once(&client, &bucket, &prefix, &dir, &stream_key, &mut uploaded).await;
    });

    S3Sync { stop_tx, handle }
}

impl S3Sync {
    pub async fn stop(self) {
        let _ = self.stop_tx.send(true);
        let _ = self.handle.await;
    }
}

async fn sync_once(
    client: &Client,
    bucket: &str,
    prefix: &str,
    dir: &std::path::Path,
    stream_key: &str,
    uploaded: &mut HashSet<String>,
) {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(err) => {
            tracing::warn!(error = %err, dir = %dir.display(), "failed to list local HLS output for S3 sync");
            return;
        }
    };

    let mut manifest_path = None;
    let mut new_files = Vec::new();

    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(err) => {
                tracing::warn!(error = %err, dir = %dir.display(), "failed to read a directory entry during S3 sync");
                break;
            }
        };

        let Ok(file_name) = entry.file_name().into_string() else {
            continue;
        };

        if file_name == MANIFEST_FILENAME {
            manifest_path = Some(entry.path());
        } else if !uploaded.contains(&file_name) {
            new_files.push((file_name, entry.path()));
        }
    }

    // Segments (and the init segment) before the manifest — a manifest that
    // already references a segment name is only useful to a viewer once
    // that segment actually exists at the URL it names.
    for (file_name, path) in new_files {
        let key = format!("{prefix}/{stream_key}/{file_name}");
        match upload(client, bucket, &key, &path, segment_content_type(&file_name), None).await {
            Ok(()) => {
                uploaded.insert(file_name);
            }
            Err(err) => {
                tracing::warn!(error = %err, key, "failed to upload live HLS segment to S3");
            }
        }
    }

    if let Some(path) = manifest_path {
        let key = format!("{prefix}/{stream_key}/{MANIFEST_FILENAME}");
        if let Err(err) = upload(
            client,
            bucket,
            &key,
            &path,
            "application/vnd.apple.mpegurl",
            Some("no-cache"),
        )
        .await
        {
            tracing::warn!(error = %err, key, "failed to upload live HLS manifest to S3");
        }
    }
}

fn segment_content_type(file_name: &str) -> &'static str {
    if file_name.ends_with(".m4s") || file_name.ends_with(".mp4") {
        "video/mp4"
    } else {
        "application/octet-stream"
    }
}

async fn upload(
    client: &Client,
    bucket: &str,
    key: &str,
    path: &std::path::Path,
    content_type: &str,
    cache_control: Option<&str>,
) -> anyhow::Result<()> {
    let body = ByteStream::from_path(path).await?;
    let mut request = client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(body)
        .content_type(content_type);
    if let Some(cache_control) = cache_control {
        request = request.cache_control(cache_control);
    } else {
        // Segments are immutable once written (a unique, never-reused
        // filename per segment) — safe to cache for a long time, unlike the
        // manifest above.
        request = request.cache_control("public, max-age=31536000, immutable");
    }
    request.send().await?;
    Ok(())
}
