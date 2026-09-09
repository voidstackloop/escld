use bytes::BytesMut;
use tokio::io::AsyncWrite;

use crate::amf::{self, object, AmfValue, AmfVersion};

use super::message::{MSG_TYPE_COMMAND_AMF0, MSG_TYPE_COMMAND_AMF3};
use super::writer::{write_message, COMMAND_CHUNK_STREAM_ID};

/// A parsed incoming command message — `connect`/`createStream`/`publish`
/// are the only three this server ever needs to act on (see rtmp.rs);
/// anything else (`releaseStream`, `FCPublish`, etc. — extra commands OBS
/// sends that plenty of real servers just ignore) is represented here too,
/// generically, and the session loop's `_ => {}` arm is what actually
/// discards them.
pub struct Command {
    pub name: String,
    pub transaction_id: f64,
    pub command_object: AmfValue,
    pub args: Vec<AmfValue>,
}

/// Parses one command message's payload, decoded with whichever AMF version
/// the message's own `type_id` declared (see `rtmp.rs::session_loop`'s
/// dispatch) — decode version and the connection's negotiated *response*
/// version (`AmfVersion` threaded through the `send_*` functions below) are
/// deliberately independent state, per the real RTMP spec. Every RTMP
/// command message has this same three-value shape at minimum (name,
/// transaction id, command object — the object is legitimately
/// `AmfValue::Null` for several real commands like `createStream`);
/// anything after that is a command-specific list of further arguments.
pub fn parse(decode_version: AmfVersion, payload: bytes::Bytes) -> anyhow::Result<Command> {
    let mut values = amf::decode_all(decode_version, payload)?.into_iter();
    let name = values
        .next()
        .and_then(|v| v.as_str().map(str::to_string))
        .ok_or_else(|| anyhow::anyhow!("command message missing its command-name string"))?;
    let transaction_id = values
        .next()
        .and_then(|v| v.as_f64())
        .ok_or_else(|| anyhow::anyhow!("command message missing its transaction-id number"))?;
    let command_object = values.next().unwrap_or(AmfValue::Null);
    let args: Vec<AmfValue> = values.collect();

    Ok(Command {
        name,
        transaction_id,
        command_object,
        args,
    })
}

async fn send_command<W: AsyncWrite + Unpin>(
    w: &mut W,
    version: AmfVersion,
    message_stream_id: u32,
    values: &[AmfValue],
) -> anyhow::Result<()> {
    let mut payload = BytesMut::new();
    for value in values {
        amf::encode(version, value, &mut payload);
    }
    let type_id = match version {
        AmfVersion::Amf0 => MSG_TYPE_COMMAND_AMF0,
        AmfVersion::Amf3 => MSG_TYPE_COMMAND_AMF3,
    };
    write_message(w, COMMAND_CHUNK_STREAM_ID, type_id, 0, message_stream_id, &payload).await
}

/// Response to a successful `connect` — `_result` with the two standard
/// object arguments every client expects (server identity/capabilities,
/// then the actual NetConnection.Connect.Success status). Always sent on
/// message stream id 0, the connection's own control stream. `version` is
/// the connection's negotiated response encoding (see `AmfVersion`'s own
/// doc) — for this specific response it's also the value that was just
/// decided from this same `connect` command's `objectEncoding` field (see
/// `rtmp.rs::handle_command`), so this response is the first one to
/// actually use it.
pub async fn send_connect_success<W: AsyncWrite + Unpin>(w: &mut W, version: AmfVersion, transaction_id: f64) -> anyhow::Result<()> {
    let properties = object([
        ("fmsVer", AmfValue::String("FMS/3,5,7,7009".to_string())),
        ("capabilities", AmfValue::Number(31.0)),
    ]);
    let information = object([
        ("level", AmfValue::String("status".to_string())),
        ("code", AmfValue::String("NetConnection.Connect.Success".to_string())),
        ("description", AmfValue::String("Connection succeeded.".to_string())),
    ]);
    send_command(
        w,
        version,
        0,
        &[
            AmfValue::String("_result".to_string()),
            AmfValue::Number(transaction_id),
            properties,
            information,
        ],
    )
    .await
}

/// Response to `createStream` — `_result` carrying the newly "created"
/// stream's message stream id. This server doesn't actually allocate
/// anything distinct per stream (there's exactly one logical stream per
/// connection, ever — see rtmp.rs), so it always returns the same fixed
/// id; real clients treat this as an opaque handle and never assume
/// anything about its specific value.
pub async fn send_create_stream_success<W: AsyncWrite + Unpin>(
    w: &mut W,
    version: AmfVersion,
    transaction_id: f64,
    new_stream_id: u32,
) -> anyhow::Result<()> {
    send_command(
        w,
        version,
        0,
        &[
            AmfValue::String("_result".to_string()),
            AmfValue::Number(transaction_id),
            AmfValue::Null,
            AmfValue::Number(new_stream_id as f64),
        ],
    )
    .await
}

/// `onStatus` acknowledging a `publish` request — sent on the *publishing*
/// stream's own message stream id (not 0), matching where the client's own
/// `publish` command arrived on. `NetStream.Publish.Start` means "go ahead,
/// start sending audio/video"; a caller passing a `BadName`/`Unauthorized`
/// code instead is expected to close the connection right after (see
/// rtmp.rs's stream-key rejection path) — sending the status is a
/// courtesy so the client's own UI can show a real error, not silently hang.
pub async fn send_publish_status<W: AsyncWrite + Unpin>(
    w: &mut W,
    version: AmfVersion,
    message_stream_id: u32,
    level: &str,
    code: &str,
    description: &str,
) -> anyhow::Result<()> {
    let info = object([
        ("level", AmfValue::String(level.to_string())),
        ("code", AmfValue::String(code.to_string())),
        ("description", AmfValue::String(description.to_string())),
    ]);
    send_command(
        w,
        version,
        message_stream_id,
        &[
            AmfValue::String("onStatus".to_string()),
            AmfValue::Number(0.0),
            AmfValue::Null,
            info,
        ],
    )
    .await
}
