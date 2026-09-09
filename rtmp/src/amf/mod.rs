pub mod amf0;
pub mod amf3;
pub mod constants;
pub mod value;

pub use value::{object, AmfValue};

/// Which wire format a connection has negotiated for its command messages —
/// decided once, from the `connect` command's `objectEncoding` field
/// (`0`/absent = AMF0, `3` = AMF3), never re-decided per message. See
/// `rtmp/src/rtmp/rtmp.rs::session_loop`'s own doc comment for why this is
/// tracked separately from how an *incoming* message is decoded (always
/// dispatched by that message's own `type_id`, not by this state).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AmfVersion {
    #[default]
    Amf0,
    Amf3,
}

pub fn decode_all(version: AmfVersion, buf: bytes::Bytes) -> anyhow::Result<Vec<AmfValue>> {
    match version {
        AmfVersion::Amf0 => amf0::decode_all(buf),
        AmfVersion::Amf3 => amf3::decode_all(buf),
    }
}

pub fn encode(version: AmfVersion, value: &AmfValue, out: &mut bytes::BytesMut) {
    match version {
        AmfVersion::Amf0 => amf0::encode(value, out),
        AmfVersion::Amf3 => amf3::encode(value, out),
    }
}
