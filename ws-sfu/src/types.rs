use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The authenticated identity resolved for a socket at connect time, stored
/// in the socket's extensions and used as `userId` everywhere from then on.
///
/// This is deliberately the Postgres `users.id`, not the Cognito `sub`: every
/// other part of the app (posts, follows, comments) identifies a user by that
/// id, so ws-sfu resolves `sub -> users.id` once at connect and uses this
/// value for `participantIds`, `ChatMessage.senderId`, and call `userId`s.
#[derive(Debug, Clone)]
pub struct Identity {
    pub user_id: Uuid,
    pub username: String,
    /// Cognito User Pool Group names ("admin", "moderator"). Enforced via
    /// `has_role` for call recording (see ws/call.rs) - the one moderator
    /// action that exists so far.
    pub roles: Vec<String>,
    /// From the Socket.IO `auth` payload's `correlationId` if the frontend
    /// sent one (e.g. the connection was opened right after an HTTP action
    /// carrying its own X-Correlation-Id), else generated fresh at connect
    /// time - see ws::try_authenticate. Logged on connect/disconnect so this
    /// connection's lifetime can be cross-referenced against the backend's
    /// request logs for the same user action.
    pub correlation_id: String,
}

impl Identity {
    pub fn has_role(&self, role: &str) -> bool {
        self.roles.iter().any(|r| r.eq_ignore_ascii_case(role))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConversationType {
    Dm,
    Group,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ConversationType,
    pub participant_ids: Vec<String>,
    pub name: Option<String>,
    pub created_at: String,
    pub last_message_at: String,
    pub last_message_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub conversation_id: String,
    pub sender_id: String,
    pub body: String,
    pub created_at: String,
}
