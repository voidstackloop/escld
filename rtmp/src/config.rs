use std::env;

/// Loaded once at startup from the environment — same shape as
/// ws-sfu/src/config.rs, which this service otherwise mirrors closely
/// (a Rust binary needing a persistent TCP port, with its own direct
/// Postgres connection).
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,

    pub db_host: String,
    pub db_port: u16,
    pub db_name: String,
    pub db_user: String,
    pub db_password: String,
    pub db_ssl: bool,

    /// Root directory live HLS output is written under, one subdirectory
    /// per stream key (see hls.rs) — analogous to ws-sfu's `recording_dir`.
    pub hls_dir: String,
    /// Target full-segment duration — real segment cuts still only happen
    /// at a keyframe boundary under `-c copy` (this server never
    /// re-encodes), so the actual segment length in practice is bounded
    /// below by the encoder's own keyframe interval (OBS's default is
    /// commonly 2s), not this value alone. This is the low-latency lever
    /// mainline ffmpeg's `hls` muxer actually offers — see hls.rs's own doc
    /// comment on why true LL-HLS partial segments (`EXT-X-PART`) aren't
    /// available at all: confirmed directly against a real `ffmpeg -h
    /// muxer=hls` run that no current ffmpeg version implements them.
    pub hls_segment_seconds: u32,
    /// How many segments the live playlist keeps before ffmpeg drops the
    /// oldest — bounds both disk use and how far a viewer can seek back. A
    /// shorter `hls_segment_seconds` needs a larger window here so the live
    /// edge doesn't sit uncomfortably close to the last keyframe boundary.
    pub hls_playlist_size: u32,

    /// `None` means no S3 delivery bucket exists in this environment (e.g.
    /// local dev) — s3_sync.rs simply never starts, and a stream stays
    /// reachable only via this instance's own local-disk `/hls/*` route.
    /// Same graceful-degradation shape as ws-sfu's `recordings_bucket`.
    pub live_bucket: Option<String>,
    pub live_bucket_prefix: String,
    /// How often `s3_sync.rs` polls the local HLS output directory for new/
    /// changed files — the other real lever (besides segment length) for
    /// cutting delivered latency within a fixed S3+CloudFront delivery
    /// path: a new segment sitting on disk isn't visible to any viewer
    /// until this poll picks it up and uploads it.
    pub s3_sync_poll_ms: u64,

    /// `None` means no shared Redis is configured — `live_viewers::peak_viewer_count`
    /// simply skips the lookup and a crash-ended stream's `peak_viewer_count`
    /// stays null, the same honest degradation this app already accepts for
    /// every other optional integration.
    pub redis_host: Option<String>,
    pub redis_port: u16,

    /// `None` means no MSK cluster is configured (e.g. local dev) — the
    /// `warehouse` module's Kafka producer is never even constructed, same
    /// `app.kafka.enabled=false`-by-absence shape as the Java backend's own
    /// `KafkaConfig` (see its own doc comment), just expressed as
    /// Option-presence instead of a second boolean flag.
    pub kafka_cluster_arn: Option<String>,
    pub kafka_region: String,

    /// Local-testing-only escape hatch: a plain "host:port" pointing at a
    /// PLAINTEXT Kafka broker (docker-compose's `kafka` service), bypassing
    /// the MSK `GetBootstrapBrokers` call and IAM/OAUTHBEARER auth entirely.
    /// `None` in every real environment — takes priority over
    /// `kafka_cluster_arn` when both happen to be set, since it only ever
    /// gets set deliberately for local testing.
    pub kafka_local_bootstrap_servers: Option<String>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            port: env_or("PORT", "1935").parse()?,

            db_host: env_or("DB_HOST", "localhost"),
            db_port: env_or("DB_PORT", "5432").parse()?,
            db_name: env_or("DB_NAME", "escld"),
            db_user: env_or("DB_USER", "escld"),
            db_password: env_or("DB_PASSWORD", "escld"),
            db_ssl: env_or("DB_SSL", "false").parse()?,

            hls_dir: env_or("HLS_DIR", "/tmp/rtmp-hls"),
            // Squeezed as low as is safe without partial segments: 1s
            // target segments (real cuts still wait for the next keyframe)
            // with a slightly larger playlist window than the old 4s/6
            // defaults needed, so the live edge stays comfortably behind
            // the most recent completed segment.
            hls_segment_seconds: env_or("HLS_SEGMENT_SECONDS", "1").parse()?,
            hls_playlist_size: env_or("HLS_PLAYLIST_SIZE", "10").parse()?,

            live_bucket: env_opt("LIVE_BUCKET_NAME"),
            live_bucket_prefix: env_or("LIVE_BUCKET_PREFIX", "live"),
            s3_sync_poll_ms: env_or("S3_SYNC_POLL_MS", "100").parse()?,

            redis_host: env_opt("REDIS_HOST"),
            redis_port: env_or("REDIS_PORT", "6379").parse()?,

            kafka_cluster_arn: env_opt("KAFKA_CLUSTER_ARN"),
            kafka_region: env_or("AWS_REGION", "eu-central-1"),
            kafka_local_bootstrap_servers: env_opt("KAFKA_LOCAL_BOOTSTRAP_SERVERS"),
        })
    }
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

/// Real bug found via local end-to-end testing: docker-compose's
/// `${VAR:-}` substitution sets the container's env var to a literal empty
/// string when the host-side var is unset, rather than omitting it — so a
/// plain `env::var(key).ok()` treats "present but empty" as `Some("")`, not
/// `None`. That silently flipped this service into thinking a local Kafka
/// broker (or Redis/S3 bucket) was configured when none was, causing a real
/// producer to be built against an empty bootstrap-servers string and time
/// out on every publish. Every optional env-derived config value goes
/// through this instead of a bare `env::var(...).ok()`.
fn env_opt(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.trim().is_empty())
}
