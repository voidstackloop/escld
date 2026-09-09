use std::collections::BTreeMap;

/// The shared in-memory representation both AMF0 and AMF3 decode into, and
/// both encode from — command-handling code (`rtmp/src/rtmp/command.rs`,
/// `rtmp/src/rtmp/rtmp.rs`) never needs to know which wire format produced a
/// given value, or that either format's reference-table mechanism exists:
/// an AMF0 Reference / AMF3 back-reference is always resolved transparently
/// at decode time into the real value it points to, never surfaced as its
/// own variant here.
#[derive(Debug, Clone, PartialEq)]
pub enum AmfValue {
    Number(f64),
    Boolean(bool),
    String(String),
    /// AMF0 Object (0x03) and ECMA Array (0x08) both decode here (identical
    /// wire shape beyond a discarded element-count hint), as does an AMF3
    /// dynamic object with no sealed traits and an empty class name.
    Object(BTreeMap<String, AmfValue>),
    /// AMF0 Typed Object (0x10) and an AMF3 object whose trait carries a
    /// non-empty class name both decode here.
    TypedObject { class_name: String, members: BTreeMap<String, AmfValue> },
    Null,
    Undefined,
    /// AMF0 Strict Array (0x0a) and an AMF3 Array's dense portion (with no
    /// associative members — see `amf3.rs`'s own doc on why a non-empty
    /// associative part is rejected rather than represented) both decode
    /// here.
    StrictArray(Vec<AmfValue>),
    /// AMF0 Date (0x0b) and AMF3 Date both collapse to milliseconds since
    /// the epoch — AMF0's trailing timezone field is spec-reserved (always
    /// 0) and AMF3 has no timezone field at all, so there's no real
    /// information lost by not modeling it separately.
    Date { millis: f64 },
    /// AMF0 XML Document (0x0f) and AMF3 XMLDocument/XML (0x07/0x0b, same
    /// wire shape as each other) all decode here — this server never
    /// inspects XML content, only round-trips it.
    XmlDoc(String),
    /// AMF3-only (0x0c) — AMF0 has no ByteArray marker, so this variant
    /// never comes from an AMF0 decode.
    ByteArray(Vec<u8>),
}

impl AmfValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            AmfValue::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            AmfValue::Number(n) => Some(*n),
            AmfValue::Date { millis } => Some(*millis),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&AmfValue> {
        match self {
            AmfValue::Object(map) => map.get(key),
            AmfValue::TypedObject { members, .. } => members.get(key),
            _ => None,
        }
    }
}

/// Builds an `AmfValue::Object` from `[(key, value)]` pairs — used at every
/// response call site instead of hand-building a `BTreeMap`.
pub fn object(entries: impl IntoIterator<Item = (&'static str, AmfValue)>) -> AmfValue {
    AmfValue::Object(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}
