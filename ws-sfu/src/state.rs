use std::sync::Arc;

use sqlx::PgPool;

use crate::auth::CognitoVerifier;
use crate::config::Config;
use crate::rate_limit::RateLimiters;
use crate::sfu::RoomRegistry;
use crate::store::dynamo::ConversationsRepo;
use crate::store::social_graph::FollowGraphRepo;

/// Shared application state, handed to every Socket.IO/axum handler. Cheap
/// to clone (one Arc bump) since every field that needs sharing is itself
/// already Arc-wrapped or immutable after startup.
#[derive(Clone)]
pub struct AppState(Arc<Inner>);

struct Inner {
    cognito: Arc<CognitoVerifier>,
    pg: PgPool,
    dynamo: ConversationsRepo,
    sfu: RoomRegistry,
    rate_limiters: RateLimiters,
    s3: aws_sdk_s3::Client,
    config: Arc<Config>,
    follow_graph: FollowGraphRepo,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cognito: Arc<CognitoVerifier>,
        pg: PgPool,
        dynamo: ConversationsRepo,
        sfu: RoomRegistry,
        s3: aws_sdk_s3::Client,
        config: Arc<Config>,
        follow_graph: FollowGraphRepo,
    ) -> Self {
        Self(Arc::new(Inner {
            cognito,
            pg,
            dynamo,
            sfu,
            rate_limiters: RateLimiters::new(),
            s3,
            config,
            follow_graph,
        }))
    }

    pub fn s3(&self) -> &aws_sdk_s3::Client {
        &self.0.s3
    }

    pub fn config(&self) -> &Config {
        &self.0.config
    }

    pub fn cognito(&self) -> &CognitoVerifier {
        &self.0.cognito
    }

    pub fn pg(&self) -> &PgPool {
        &self.0.pg
    }

    pub fn dynamo(&self) -> &ConversationsRepo {
        &self.0.dynamo
    }

    pub fn sfu(&self) -> &RoomRegistry {
        &self.0.sfu
    }

    pub fn rate_limiters(&self) -> &RateLimiters {
        &self.0.rate_limiters
    }

    pub fn follow_graph(&self) -> &FollowGraphRepo {
        &self.0.follow_graph
    }
}
