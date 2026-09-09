pub mod call;
pub mod live;
pub mod messaging;

use serde::Deserialize;
use socketioxide::extract::{Data, SocketRef, State};

use crate::metrics;
use crate::state::AppState;
use crate::store::postgres;
use crate::types::Identity;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthPayload {
    #[serde(default)]
    pub token: String,
    /// Optional - a fresh one is generated in try_authenticate if the client
    /// doesn't send one (e.g. a page load that never made an HTTP request
    /// first, so there's no existing X-Correlation-Id to carry over).
    #[serde(default)]
    pub correlation_id: Option<String>,
}

/// Connect middleware: verifies the Cognito access token from the handshake
/// `auth` payload and resolves it to the canonical Postgres `users.id`. On
/// any failure this returns `Err`, which socketioxide surfaces to the client
/// as a `connect_error` event - the socket never actually connects. See
/// `AppState::cognito`/`store::postgres::find_by_cognito_sub` for the two
/// verification steps.
pub async fn authenticate(
    s: SocketRef,
    Data(auth): Data<AuthPayload>,
    State(state): State<AppState>,
) -> anyhow::Result<()> {
    match try_authenticate(&s, &auth, &state).await {
        Ok(()) => Ok(()),
        Err(err) => {
            metrics::AUTH_FAILURES_TOTAL.inc();
            crate::emf::emit_count("ws_sfu_auth_failures_total", &[]);
            Err(err)
        }
    }
}

async fn try_authenticate(s: &SocketRef, auth: &AuthPayload, state: &AppState) -> anyhow::Result<()> {
    if auth.token.is_empty() {
        anyhow::bail!("missing auth token");
    }

    let claims = state.cognito().verify_access_token(&auth.token).await?;
    let cognito_sub: uuid::Uuid = claims
        .sub
        .parse()
        .map_err(|_| anyhow::anyhow!("token sub is not a valid uuid"))?;

    let user = postgres::find_by_cognito_sub(state.pg(), cognito_sub)
        .await?
        .ok_or_else(|| anyhow::anyhow!("no profile provisioned for this account yet"))?;

    let correlation_id = auth
        .correlation_id
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    s.extensions.insert(Identity {
        user_id: user.id,
        username: user.username,
        roles: claims.groups,
        correlation_id,
    });

    Ok(())
}

pub async fn on_connect(s: SocketRef) {
    let identity = s
        .extensions
        .get::<Identity>()
        .expect("authenticate middleware always sets Identity before on_connect runs");
    tracing::info!(
        socket = %s.id,
        user_id = %identity.user_id,
        username = %identity.username,
        correlation_id = %identity.correlation_id,
        "socket connected"
    );
    metrics::SOCKETS_CONNECTED.inc();
    crate::emf::emit_gauge("ws_sfu_sockets_connected", metrics::SOCKETS_CONNECTED.get() as f64);

    // A small, generally-reusable primitive beyond just the live-feed push
    // it was added for (kafka/mod.rs::deliver_live_event): any future
    // feature needing to target "this specific user's connection(s)"
    // (multiple tabs/devices all join the same room) can reuse it.
    s.join(format!("user:{}", identity.user_id));

    messaging::register(&s);
    call::register(&s);
    live::register(&s);

    s.on_disconnect(async |s: SocketRef, State(state): State<AppState>| {
        let correlation_id = s
            .extensions
            .get::<Identity>()
            .map(|identity| identity.correlation_id.clone())
            .unwrap_or_default();
        tracing::info!(socket = %s.id, correlation_id = %correlation_id, "socket disconnected");
        metrics::SOCKETS_CONNECTED.dec();
        crate::emf::emit_gauge("ws_sfu_sockets_connected", metrics::SOCKETS_CONNECTED.get() as f64);
        call::cleanup_on_disconnect(&s, &state).await;
        state.rate_limiters().remove(s.id.as_str());
    });
}
