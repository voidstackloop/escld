use std::env;

/// Loaded once at startup from the environment. Mirrors the `ws-sfu` service
/// block in the repo root `docker-compose.yaml` exactly - every var read here
/// has a corresponding entry there.
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub cors_allowed_origins: Vec<String>,

    pub aws_region: String,
    pub dynamodb_endpoint: Option<String>,
    pub dynamodb_conversations_table: String,
    /// Read-only access to the Java backend's follow graph — see
    /// `store/social_graph.rs`, used only by the Kafka-driven live-feed
    /// push (`kafka/mod.rs`).
    pub dynamodb_follows_table: String,

    pub cognito_issuer_uri: String,
    pub cognito_app_client_id: String,

    pub db_host: String,
    pub db_port: u16,
    pub db_name: String,
    pub db_user: String,
    pub db_password: String,
    pub db_ssl: bool,

    pub mediasoup_worker_count: usize,
    pub mediasoup_listen_ip: String,
    pub mediasoup_announced_ip: String,
    pub mediasoup_rtc_min_port: u16,
    pub mediasoup_rtc_max_port: u16,

    /// S3 bucket call recordings are uploaded to. `None` disables the
    /// feature entirely (`call:startRecording` fails cleanly) - there's no
    /// local S3 emulator in docker-compose, so dev environments run without it.
    pub recordings_bucket: Option<String>,
    /// Scratch directory for in-progress recording files before they're
    /// uploaded to `recordings_bucket` and deleted.
    pub recording_dir: String,

    /// `None` means no MSK cluster is configured (e.g. local dev) — the
    /// `kafka` module's consumer is never even constructed, same
    /// `app.kafka.enabled=false`-by-absence shape as the Java backend's own
    /// `KafkaConfig` and `rtmp/src/config.rs`'s identical `kafka_cluster_arn`.
    pub kafka_cluster_arn: Option<String>,
    pub kafka_region: String,
    /// Local-testing-only escape hatch, same shape as `rtmp/src/config.rs`'s
    /// identical field — a plain "host:port" PLAINTEXT broker, bypassing
    /// MSK's `GetBootstrapBrokers` call and IAM/OAUTHBEARER auth entirely.
    /// Never set in a real environment.
    pub kafka_local_bootstrap_servers: Option<String>,

    /// Fraction (0.0-1.0) of the streamer's online followers who receive a
    /// `feed:liveStarted`/`feed:liveEnded` push, independently sampled per
    /// follower — see `kafka/mod.rs::deliver_live_event`. Default 1.0:
    /// followers should hear about it essentially every time.
    pub live_push_follower_weight: f64,
    /// Fraction of *other* online users (non-followers) who receive the
    /// same push — a small discovery mechanic, not a full broadcast.
    /// Default 0.1.
    pub live_push_discovery_weight: f64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        // One mediasoup worker per available core is the documented
        // recommendation (https://mediasoup.org/documentation/v3/scalability/)
        // for maximizing parallel media-packet routing without contention.
        // `available_parallelism()` reflects the container's actual CPU
        // allocation (cgroup/Docker `--cpus` quota when set, not raw host
        // hardware), which is the correct scope for a containerized
        // deployment — still overridable via MEDIASOUP_WORKER_COUNT for
        // explicit tuning.
        let default_worker_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            .to_string();

        Ok(Self {
            port: env_or("PORT", "4000").parse()?,
            cors_allowed_origins: env_or("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),

            aws_region: env_or("AWS_REGION", "eu-central-1"),
            dynamodb_endpoint: env::var("DYNAMODB_ENDPOINT").ok(),
            dynamodb_conversations_table: env_or("DYNAMODB_CONVERSATIONS_TABLE", "conversations"),
            dynamodb_follows_table: env_or("DYNAMODB_FOLLOWS_TABLE", "follows"),

            cognito_issuer_uri: env_required("COGNITO_ISSUER_URI")?,
            cognito_app_client_id: env_required("COGNITO_APP_CLIENT_ID")?,

            db_host: env_or("DB_HOST", "localhost"),
            db_port: env_or("DB_PORT", "5432").parse()?,
            db_name: env_or("DB_NAME", "escld"),
            db_user: env_or("DB_USER", "escld"),
            db_password: env_or("DB_PASSWORD", "escld"),
            db_ssl: env_or("DB_SSL", "false").parse()?,

            mediasoup_worker_count: {
                let count: usize = env_or("MEDIASOUP_WORKER_COUNT", &default_worker_count).parse()?;
                // WorkerPool::next_worker() does `% self.workers.len()` — a
                // count of 0 would divide by zero the first time any room is
                // created, rather than failing fast here at startup.
                anyhow::ensure!(count > 0, "MEDIASOUP_WORKER_COUNT must be at least 1, got 0");
                count
            },
            mediasoup_listen_ip: env_or("MEDIASOUP_LISTEN_IP", "0.0.0.0"),
            mediasoup_announced_ip: env_or("MEDIASOUP_ANNOUNCED_IP", "127.0.0.1"),
            // Every mediasoup worker process draws WebRTC transport ports
            // from this *same* shared range (see WorkerPool::new) — it isn't
            // partitioned per worker. A range sized for one worker would
            // silently cap total instance-wide transport capacity regardless
            // of MEDIASOUP_WORKER_COUNT, so this default is sized for real
            // headroom, not just enough for a single process. Keep in sync
            // with infra/lib/ws-sfu-stack.ts's security-group rule and
            // docker-compose.yaml's published port range.
            mediasoup_rtc_min_port: env_or("MEDIASOUP_RTC_MIN_PORT", "40000").parse()?,
            mediasoup_rtc_max_port: env_or("MEDIASOUP_RTC_MAX_PORT", "40999").parse()?,

            recordings_bucket: env::var("RECORDINGS_BUCKET").ok().filter(|s| !s.is_empty()),
            recording_dir: env_or("RECORDING_DIR", "/tmp/ws-sfu-recordings"),

            kafka_cluster_arn: env_opt("KAFKA_CLUSTER_ARN"),
            kafka_region: env_or("AWS_REGION", "eu-central-1"),
            kafka_local_bootstrap_servers: env_opt("KAFKA_LOCAL_BOOTSTRAP_SERVERS"),

            live_push_follower_weight: env_or("LIVE_PUSH_FOLLOWER_WEIGHT", "1.0").parse()?,
            live_push_discovery_weight: env_or("LIVE_PUSH_DISCOVERY_WEIGHT", "0.1").parse()?,
        })
    }
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

/// Same real bug this repo already hit once (see `rtmp/src/config.rs`'s
/// identical helper): docker-compose's `${VAR:-}` substitution sets a
/// container's env var to a literal empty string when unset, rather than
/// omitting it — a bare `env::var(key).ok()` would treat that as `Some("")`
/// and silently activate whatever this value gates.
fn env_opt(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.trim().is_empty())
}

fn env_required(key: &str) -> anyhow::Result<String> {
    env::var(key).map_err(|_| anyhow::anyhow!("missing required env var {key}"))
}
