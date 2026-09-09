use std::collections::BTreeMap;

use bytes::{Buf, BufMut, Bytes, BytesMut};

use super::constants::*;
use super::value::AmfValue;

/// Tracks every Object/ECMA-Array/Strict-Array/Typed-Object decoded so far in
/// the current message body, so a later Reference (0x07) can point back at
/// an earlier value by index — real AMF0 encoders use this to avoid
/// re-sending a repeated object. Registered right after a value fully
/// decodes, not before: `AmfValue` is a plain owned tree (not a graph), so a
/// value can never literally contain a reference to itself anyway — this
/// correctly resolves the realistic case (referencing an earlier *sibling*
/// value, the only shape any real RTMP encoder's connect/publish command
/// sends) without pretending to support genuine self-referential cycles,
/// which this representation has no way to hold regardless of ordering.
struct DecodeCtx {
    objects: Vec<AmfValue>,
}

impl DecodeCtx {
    fn new() -> Self {
        Self { objects: Vec::new() }
    }

    fn register(&mut self, value: &AmfValue) {
        if matches!(value, AmfValue::Object(_) | AmfValue::TypedObject { .. } | AmfValue::StrictArray(_)) {
            self.objects.push(value.clone());
        }
    }
}

/// Decodes exactly one AMF0-encoded value from the front of `buf`, advancing
/// it past the bytes consumed. Starts a fresh reference table — for a full
/// message body use `decode_all`, not repeated calls to this, since AMF0's
/// reference table is scoped to the whole body, not to one value.
pub fn decode(buf: &mut Bytes) -> anyhow::Result<AmfValue> {
    let mut ctx = DecodeCtx::new();
    decode_value(buf, &mut ctx)
}

/// Decodes every value remaining in `buf` — the whole body of one RTMP
/// command or data message. All values share one reference table, matching
/// the real AMF0 spec: a later argument can reference an object introduced
/// by an earlier one in the same message.
pub fn decode_all(mut buf: Bytes) -> anyhow::Result<Vec<AmfValue>> {
    let mut ctx = DecodeCtx::new();
    let mut values = Vec::new();
    while !buf.is_empty() {
        values.push(decode_value(&mut buf, &mut ctx)?);
    }
    Ok(values)
}

fn decode_value(buf: &mut Bytes, ctx: &mut DecodeCtx) -> anyhow::Result<AmfValue> {
    if buf.is_empty() {
        anyhow::bail!("AMF0 decode: unexpected end of buffer reading a type marker");
    }
    let marker = buf.get_u8();

    // Resolving a reference never registers a new table entry — it returns
    // an existing one — so this is handled before the common `ctx.register`
    // call below, not inside the match arm that feeds it.
    if marker == AMF0_REFERENCE_MARKER {
        require(buf, 2, "reference index")?;
        let index = buf.get_u16() as usize;
        return ctx
            .objects
            .get(index)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("AMF0 decode: reference index {index} out of range"));
    }

    let value = match marker {
        AMF0_NUMBER_MARKER => {
            require(buf, 8, "number")?;
            AmfValue::Number(buf.get_f64())
        }
        AMF0_BOOLEAN_MARKER => {
            require(buf, 1, "boolean")?;
            AmfValue::Boolean(buf.get_u8() != 0)
        }
        AMF0_STRING_MARKER => AmfValue::String(decode_short_string(buf)?),
        AMF0_OBJECT_MARKER => AmfValue::Object(decode_object_body(buf, ctx)?),
        AMF0_NULL_MARKER => AmfValue::Null,
        AMF0_UNDEFINED_MARKER => AmfValue::Undefined,
        AMF0_ECMA_ARRAY_MARKER => {
            require(buf, 4, "ECMA array count")?;
            let _count_hint = buf.get_u32();
            AmfValue::Object(decode_object_body(buf, ctx)?)
        }
        AMF0_STRICT_ARRAY_MARKER => {
            require(buf, 4, "strict array count")?;
            let count = buf.get_u32();
            let mut items = Vec::with_capacity(count as usize);
            for _ in 0..count {
                items.push(decode_value(buf, ctx)?);
            }
            AmfValue::StrictArray(items)
        }
        AMF0_DATE_MARKER => {
            require(buf, 10, "date")?;
            let millis = buf.get_f64();
            let _timezone = buf.get_i16(); // spec-reserved, always 0 — read and discard
            AmfValue::Date { millis }
        }
        AMF0_LONG_STRING_MARKER => AmfValue::String(decode_long_string(buf)?),
        AMF0_XML_DOCUMENT_MARKER => AmfValue::XmlDoc(decode_long_string(buf)?),
        AMF0_TYPED_OBJECT_MARKER => {
            let class_name = decode_short_string(buf)?;
            let members = decode_object_body(buf, ctx)?;
            AmfValue::TypedObject { class_name, members }
        }
        other => anyhow::bail!("AMF0 decode: unsupported marker 0x{other:02x}"),
    };
    ctx.register(&value);
    Ok(value)
}

fn require(buf: &Bytes, n: usize, what: &str) -> anyhow::Result<()> {
    if buf.remaining() < n {
        anyhow::bail!("AMF0 decode: buffer too short reading a {what} ({} < {n} bytes)", buf.remaining());
    }
    Ok(())
}

/// AMF0's "short string" shape (used for plain String values, object keys):
/// a 2-byte big-endian length prefix, then that many UTF-8 bytes.
fn decode_short_string(buf: &mut Bytes) -> anyhow::Result<String> {
    require(buf, 2, "string length")?;
    let len = buf.get_u16() as usize;
    require(buf, len, "string body")?;
    let bytes = buf.copy_to_bytes(len);
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// AMF0's "long string" shape (Long String and XML Document both use this):
/// a 4-byte big-endian length prefix, for strings that may exceed a 2-byte
/// length's range.
fn decode_long_string(buf: &mut Bytes) -> anyhow::Result<String> {
    require(buf, 4, "long string length")?;
    let len = buf.get_u32() as usize;
    require(buf, len, "long string body")?;
    let bytes = buf.copy_to_bytes(len);
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Shared by Object, ECMA Array, and Typed Object: a sequence of
/// (short-string key, value) pairs, terminated by an empty key followed by
/// the Object End marker (0x00 0x00 0x09) — not by any length prefix, so
/// this has to scan until it actually sees that terminator.
fn decode_object_body(buf: &mut Bytes, ctx: &mut DecodeCtx) -> anyhow::Result<BTreeMap<String, AmfValue>> {
    let mut map = BTreeMap::new();
    loop {
        require(buf, 2, "object key length")?;
        // Peek the key length without consuming yet, so a zero-length key
        // (the terminator's own empty "key") can be told apart from a real
        // one before committing to reading a value after it.
        let key_len = u16::from_be_bytes([buf[0], buf[1]]) as usize;
        if key_len == 0 {
            buf.advance(2);
            require(buf, 1, "object end marker")?;
            let end_marker = buf.get_u8();
            if end_marker != AMF0_OBJECT_END_MARKER {
                anyhow::bail!("AMF0 decode: expected object end marker 0x09, got 0x{end_marker:02x}");
            }
            return Ok(map);
        }
        let key = decode_short_string(buf)?;
        let value = decode_value(buf, ctx)?;
        map.insert(key, value);
    }
}

/// Encodes one AMF0 value onto the end of `out` — the inverse of `decode`.
/// Never emits a Reference: every value this server sends is written fresh,
/// which is fully spec-legal (references are an optional space-saving
/// device, not a requirement) and needs no encode-side reference table at
/// all — the same simplification `amf3.rs`'s encoder makes.
pub fn encode(value: &AmfValue, out: &mut BytesMut) {
    match value {
        AmfValue::Number(n) => {
            out.put_u8(AMF0_NUMBER_MARKER);
            out.put_f64(*n);
        }
        AmfValue::Boolean(b) => {
            out.put_u8(AMF0_BOOLEAN_MARKER);
            out.put_u8(if *b { 1 } else { 0 });
        }
        AmfValue::String(s) => {
            // A string over a 2-byte length's range (65535 bytes) must use
            // the Long String marker instead — this server never sends one
            // itself (every real response string is short), but this keeps
            // encode a correct general-purpose inverse of decode rather
            // than one that only works for the specific strings this
            // server happens to send today.
            if s.len() > u16::MAX as usize {
                out.put_u8(AMF0_LONG_STRING_MARKER);
                encode_long_string(s, out);
            } else {
                out.put_u8(AMF0_STRING_MARKER);
                encode_short_string(s, out);
            }
        }
        AmfValue::Object(map) => {
            out.put_u8(AMF0_OBJECT_MARKER);
            encode_object_body(map, out);
        }
        AmfValue::TypedObject { class_name, members } => {
            out.put_u8(AMF0_TYPED_OBJECT_MARKER);
            encode_short_string(class_name, out);
            encode_object_body(members, out);
        }
        AmfValue::Null => out.put_u8(AMF0_NULL_MARKER),
        AmfValue::Undefined => out.put_u8(AMF0_UNDEFINED_MARKER),
        AmfValue::StrictArray(items) => {
            out.put_u8(AMF0_STRICT_ARRAY_MARKER);
            out.put_u32(items.len() as u32);
            for item in items {
                encode(item, out);
            }
        }
        AmfValue::Date { millis } => {
            out.put_u8(AMF0_DATE_MARKER);
            out.put_f64(*millis);
            out.put_i16(0); // reserved timezone field, always 0 per spec
        }
        AmfValue::XmlDoc(xml) => {
            out.put_u8(AMF0_XML_DOCUMENT_MARKER);
            encode_long_string(xml, out);
        }
        AmfValue::ByteArray(_) => {
            // AMF0 has no ByteArray marker at all. This server never
            // constructs one to send over AMF0 (ByteArray only ever comes
            // from decoding an AMF3 message) — reachable only via a caller
            // bug, not any real client interaction.
            unreachable!("ByteArray has no AMF0 wire representation");
        }
    }
}

fn encode_short_string(s: &str, out: &mut BytesMut) {
    // Real string values sent by this server (status codes, descriptions,
    // usernames) are always well under u16::MAX bytes — not worth a
    // fallible API for a ceiling that can't realistically be hit here.
    out.put_u16(s.len() as u16);
    out.put_slice(s.as_bytes());
}

fn encode_long_string(s: &str, out: &mut BytesMut) {
    out.put_u32(s.len() as u32);
    out.put_slice(s.as_bytes());
}

fn encode_object_body(map: &BTreeMap<String, AmfValue>, out: &mut BytesMut) {
    for (key, value) in map {
        encode_short_string(key, out);
        encode(value, out);
    }
    out.put_u16(0);
    out.put_u8(AMF0_OBJECT_END_MARKER);
}

#[cfg(test)]
mod tests {
    use super::super::value::object;
    use super::*;

    fn roundtrip(value: AmfValue) -> AmfValue {
        let mut buf = BytesMut::new();
        encode(&value, &mut buf);
        let mut bytes = buf.freeze();
        decode(&mut bytes).expect("decode should succeed on what we just encoded")
    }

    #[test]
    fn roundtrips_a_number() {
        assert_eq!(roundtrip(AmfValue::Number(3.5)), AmfValue::Number(3.5));
        assert_eq!(roundtrip(AmfValue::Number(0.0)), AmfValue::Number(0.0));
    }

    #[test]
    fn roundtrips_a_string() {
        assert_eq!(roundtrip(AmfValue::String("connect".to_string())), AmfValue::String("connect".to_string()));
    }

    #[test]
    fn roundtrips_null_and_undefined() {
        assert_eq!(roundtrip(AmfValue::Null), AmfValue::Null);
        assert_eq!(roundtrip(AmfValue::Undefined), AmfValue::Undefined);
    }

    #[test]
    fn roundtrips_a_nested_object_matching_a_real_connect_command_object() {
        let value = object([
            ("app", AmfValue::String("live".to_string())),
            ("flashVer", AmfValue::String("FMLE/3.0".to_string())),
            ("tcUrl", AmfValue::String("rtmp://localhost/live".to_string())),
            ("fpad", AmfValue::Boolean(false)),
        ]);
        assert_eq!(roundtrip(value.clone()), value);
    }

    /// The exact byte sequence for the AMF0 string "abc": marker 0x02, a
    /// 2-byte big-endian length of 3, then the UTF-8 bytes — hand-verified
    /// against the AMF0 spec rather than only checked via round-trip, so a
    /// bug that happened to be symmetric in both encode and decode (and so
    /// invisible to every round-trip test above) would still be caught.
    #[test]
    fn encodes_a_string_to_the_exact_documented_amf0_byte_shape() {
        let mut buf = BytesMut::new();
        encode(&AmfValue::String("abc".to_string()), &mut buf);
        assert_eq!(buf.as_ref(), &[0x02, 0x00, 0x03, b'a', b'b', b'c']);
    }

    #[test]
    fn decode_all_reads_every_value_in_a_real_command_message_shape() {
        // The exact structure of a real `connect` command message body:
        // command name, transaction id, command object, in that order.
        let mut buf = BytesMut::new();
        encode(&AmfValue::String("connect".to_string()), &mut buf);
        encode(&AmfValue::Number(1.0), &mut buf);
        encode(&object([("app", AmfValue::String("live".to_string()))]), &mut buf);

        let values = decode_all(buf.freeze()).unwrap();
        assert_eq!(values.len(), 3);
        assert_eq!(values[0].as_str(), Some("connect"));
        assert_eq!(values[1].as_f64(), Some(1.0));
        assert_eq!(values[2].get("app").and_then(|v| v.as_str()), Some("live"));
    }

    #[test]
    fn rejects_an_unsupported_marker_instead_of_misparsing_it() {
        let mut bytes = Bytes::from_static(&[0x04]); // MovieClip — deliberately unimplemented
        assert!(decode(&mut bytes).is_err());
    }

    #[test]
    fn roundtrips_a_strict_array() {
        let value = AmfValue::StrictArray(vec![AmfValue::Number(1.0), AmfValue::String("two".to_string()), AmfValue::Boolean(true)]);
        assert_eq!(roundtrip(value.clone()), value);
    }

    #[test]
    fn roundtrips_a_date() {
        assert_eq!(roundtrip(AmfValue::Date { millis: 1_700_000_000_000.0 }), AmfValue::Date { millis: 1_700_000_000_000.0 });
    }

    #[test]
    fn roundtrips_a_long_string() {
        let long = "x".repeat(70_000); // exceeds a 2-byte length prefix's range
        assert_eq!(roundtrip(AmfValue::String(long.clone())), AmfValue::String(long));
    }

    #[test]
    fn roundtrips_an_xml_document() {
        let xml = "<a><b/></a>".to_string();
        assert_eq!(roundtrip(AmfValue::XmlDoc(xml.clone())), AmfValue::XmlDoc(xml));
    }

    #[test]
    fn roundtrips_a_typed_object() {
        let value = object([("id", AmfValue::Number(1.0))]);
        let AmfValue::Object(members) = value else { unreachable!() };
        let typed = AmfValue::TypedObject { class_name: "com.example.Thing".to_string(), members };
        assert_eq!(roundtrip(typed.clone()), typed);
    }

    /// A real encoder sends a Reference instead of re-encoding a repeated
    /// object — this constructs that exact wire shape by hand (this
    /// encoder deliberately never emits references itself, so there's no
    /// round-trip path to exercise this through `encode`) and confirms
    /// `decode_all` resolves it back to a real copy of the first object,
    /// not a copy of whatever the reference bytes happen to look like.
    #[test]
    fn resolves_a_reference_to_an_earlier_object_in_the_same_message() {
        let shared = object([("id", AmfValue::Number(1.0))]);
        let mut buf = BytesMut::new();
        encode(&shared, &mut buf); // object at reference index 0
        buf.put_u8(AMF0_REFERENCE_MARKER);
        buf.put_u16(0);

        let values = decode_all(buf.freeze()).unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0], shared);
        assert_eq!(values[1], shared);
    }
}
