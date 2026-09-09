use std::collections::BTreeMap;

use bytes::{Buf, BufMut, Bytes, BytesMut};

use super::constants::*;
use super::value::AmfValue;

/// AMF3 maintains three independent reference tables scoped to one message
/// body (not one value) — strings, "complex" values (object/array/date/
/// xml/byteArray all share this one table), and object traits (a class's
/// name + sealed-member-list definition, reused across multiple instances
/// of the same class). Registered right after a value fully decodes: like
/// `amf0.rs`'s identical choice, `AmfValue` is a plain owned tree, so a
/// value can never literally contain itself regardless of when it's
/// registered — this resolves the realistic case (an earlier sibling value)
/// correctly without claiming to support genuine self-referential cycles.
struct DecodeCtx {
    strings: Vec<String>,
    objects: Vec<AmfValue>,
    traits: Vec<Trait>,
}

#[derive(Clone)]
struct Trait {
    class_name: String,
    sealed_members: Vec<String>,
    dynamic: bool,
}

impl DecodeCtx {
    fn new() -> Self {
        Self { strings: Vec::new(), objects: Vec::new(), traits: Vec::new() }
    }
}

/// AMF3's variable-length unsigned 29-bit integer: up to 4 bytes, high bit
/// of each of the first 3 bytes is a continuation flag (0 = this is the
/// last byte); the 4th byte, if reached, uses all 8 bits as data rather than
/// 7 — the one asymmetry in the format, implemented as an explicit special
/// case below rather than derived generically.
fn read_u29(buf: &mut Bytes) -> anyhow::Result<u32> {
    let mut result: u32 = 0;
    for i in 0..4 {
        require(buf, 1, "u29 byte")?;
        let byte = buf.get_u8();
        if i == 3 {
            result = (result << 8) | byte as u32;
            break;
        }
        result = (result << 7) | (byte & 0x7f) as u32;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
    }
    Ok(result)
}

fn write_u29(out: &mut BytesMut, value: u32) {
    debug_assert!(value <= 0x1fff_ffff, "AMF3 U29 value {value} exceeds the 29-bit range");
    if value < 0x80 {
        out.put_u8(value as u8);
    } else if value < 0x4000 {
        out.put_u8((value >> 7) as u8 | 0x80);
        out.put_u8((value & 0x7f) as u8);
    } else if value < 0x0020_0000 {
        out.put_u8((value >> 14) as u8 | 0x80);
        out.put_u8(((value >> 7) & 0x7f) as u8 | 0x80);
        out.put_u8((value & 0x7f) as u8);
    } else {
        out.put_u8((value >> 22) as u8 | 0x80);
        out.put_u8(((value >> 15) & 0x7f) as u8 | 0x80);
        out.put_u8(((value >> 8) & 0x7f) as u8 | 0x80);
        out.put_u8((value & 0xff) as u8); // last byte: all 8 bits are data
    }
}

fn require(buf: &Bytes, n: usize, what: &str) -> anyhow::Result<()> {
    if buf.remaining() < n {
        anyhow::bail!("AMF3 decode: buffer too short reading a {what} ({} < {n} bytes)", buf.remaining());
    }
    Ok(())
}

/// Every AMF3 reference-table header (string/object/date/array/xml/
/// byteArray) shares this shape: a U29 whose low bit is 0 for "this is a
/// back-reference, the rest of the bits are an index" or 1 for "a literal
/// value follows, and the rest of the bits carry a length" — decoded once
/// here and reused by every marker below rather than duplicated per type.
enum RefOrLen {
    Ref(usize),
    Len(usize),
}

fn read_ref_header(buf: &mut Bytes) -> anyhow::Result<RefOrLen> {
    let header = read_u29(buf)?;
    if header & 1 == 0 {
        Ok(RefOrLen::Ref((header >> 1) as usize))
    } else {
        Ok(RefOrLen::Len((header >> 1) as usize))
    }
}

fn decode_string_value(buf: &mut Bytes, ctx: &mut DecodeCtx) -> anyhow::Result<String> {
    match read_ref_header(buf)? {
        RefOrLen::Ref(index) => ctx
            .strings
            .get(index)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("AMF3 decode: string reference {index} out of range")),
        RefOrLen::Len(len) => {
            require(buf, len, "amf3 string body")?;
            let bytes = buf.copy_to_bytes(len);
            let s = String::from_utf8_lossy(&bytes).into_owned();
            // The empty string is spec-excluded from the reference table —
            // it's common enough (every dynamic object's member list and
            // every plain array's associative part is terminated by one)
            // that indexing it would be pure waste, not a real saving.
            if !s.is_empty() {
                ctx.strings.push(s.clone());
            }
            Ok(s)
        }
    }
}

fn decode_bytes_body(buf: &mut Bytes, len: usize) -> anyhow::Result<Bytes> {
    require(buf, len, "amf3 byte body")?;
    Ok(buf.copy_to_bytes(len))
}

fn decode_date(buf: &mut Bytes, ctx: &mut DecodeCtx) -> anyhow::Result<AmfValue> {
    match read_ref_header(buf)? {
        RefOrLen::Ref(index) => ctx
            .objects
            .get(index)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("AMF3 decode: date reference {index} out of range")),
        RefOrLen::Len(_unused) => {
            require(buf, 8, "amf3 date millis")?;
            let value = AmfValue::Date { millis: buf.get_f64() };
            ctx.objects.push(value.clone());
            Ok(value)
        }
    }
}

fn decode_xml_like(buf: &mut Bytes, ctx: &mut DecodeCtx) -> anyhow::Result<AmfValue> {
    match read_ref_header(buf)? {
        RefOrLen::Ref(index) => ctx
            .objects
            .get(index)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("AMF3 decode: xml reference {index} out of range")),
        RefOrLen::Len(len) => {
            let bytes = decode_bytes_body(buf, len)?;
            let value = AmfValue::XmlDoc(String::from_utf8_lossy(&bytes).into_owned());
            ctx.objects.push(value.clone());
            Ok(value)
        }
    }
}

fn decode_byte_array(buf: &mut Bytes, ctx: &mut DecodeCtx) -> anyhow::Result<AmfValue> {
    match read_ref_header(buf)? {
        RefOrLen::Ref(index) => ctx
            .objects
            .get(index)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("AMF3 decode: byte array reference {index} out of range")),
        RefOrLen::Len(len) => {
            let bytes = decode_bytes_body(buf, len)?;
            let value = AmfValue::ByteArray(bytes.to_vec());
            ctx.objects.push(value.clone());
            Ok(value)
        }
    }
}

/// An AMF3 array has both a dense (index-keyed) portion and an associative
/// (string-keyed) portion; the associative portion is read first, as a
/// sequence of (key, value) pairs terminated by an empty-string key. No
/// real RTMP command argument ever populates it — a plain dense array is
/// what any real encoder sends — so a non-empty associative part is
/// rejected outright rather than silently dropped, matching this
/// codebase's established "reject the unsupported rather than misparse it"
/// convention (see `amf0.rs`'s own unsupported-marker handling).
fn decode_array(buf: &mut Bytes, ctx: &mut DecodeCtx) -> anyhow::Result<AmfValue> {
    let dense_count = match read_ref_header(buf)? {
        RefOrLen::Ref(index) => {
            return ctx
                .objects
                .get(index)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("AMF3 decode: array reference {index} out of range"));
        }
        RefOrLen::Len(count) => count,
    };

    let first_key = decode_string_value(buf, ctx)?;
    if !first_key.is_empty() {
        anyhow::bail!("AMF3 decode: associative array members are not supported");
    }

    let mut items = Vec::with_capacity(dense_count);
    for _ in 0..dense_count {
        items.push(decode_value(buf, ctx)?);
    }
    let value = AmfValue::StrictArray(items);
    ctx.objects.push(value.clone());
    Ok(value)
}

/// The Object type's header has its own, more elaborate bit layout beyond
/// the shared ref-or-literal split every other type above uses: bit 0 = 0
/// is still "this is a reference," but bit 0 = 1 branches again on bit 1
/// ("a trait reference follows" vs. "a full trait definition follows"), and
/// a full trait definition branches again on bit 2 (externalizable —
/// unsupported here, see below) and carries a dynamic flag (bit 3) and a
/// sealed-member count (the remaining high bits).
fn decode_object(buf: &mut Bytes, ctx: &mut DecodeCtx) -> anyhow::Result<AmfValue> {
    let header = read_u29(buf)?;
    if header & 1 == 0 {
        let index = (header >> 1) as usize;
        return ctx
            .objects
            .get(index)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("AMF3 decode: object reference {index} out of range"));
    }

    let trait_def = if header & 2 == 0 {
        let index = (header >> 2) as usize;
        ctx.traits
            .get(index)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("AMF3 decode: trait reference {index} out of range"))?
    } else {
        if header & 4 != 0 {
            // Externalizable: the object implements its own custom
            // read/writeExternal wire format with no generic structure this
            // codec could decode without knowing the specific class — no
            // real RTMP command argument is ever externalizable.
            anyhow::bail!("AMF3 decode: externalizable objects are not supported");
        }
        let dynamic = header & 8 != 0;
        let sealed_count = (header >> 4) as usize;
        let class_name = decode_string_value(buf, ctx)?;
        let mut sealed_members = Vec::with_capacity(sealed_count);
        for _ in 0..sealed_count {
            sealed_members.push(decode_string_value(buf, ctx)?);
        }
        let trait_def = Trait { class_name, sealed_members, dynamic };
        ctx.traits.push(trait_def.clone());
        trait_def
    };

    let mut members = BTreeMap::new();
    for name in &trait_def.sealed_members {
        let value = decode_value(buf, ctx)?;
        members.insert(name.clone(), value);
    }
    if trait_def.dynamic {
        loop {
            let key = decode_string_value(buf, ctx)?;
            if key.is_empty() {
                break;
            }
            let value = decode_value(buf, ctx)?;
            members.insert(key, value);
        }
    }

    let value = if trait_def.class_name.is_empty() {
        AmfValue::Object(members)
    } else {
        AmfValue::TypedObject { class_name: trait_def.class_name, members }
    };
    ctx.objects.push(value.clone());
    Ok(value)
}

fn decode_value(buf: &mut Bytes, ctx: &mut DecodeCtx) -> anyhow::Result<AmfValue> {
    if buf.is_empty() {
        anyhow::bail!("AMF3 decode: unexpected end of buffer reading a type marker");
    }
    let marker = buf.get_u8();
    match marker {
        AMF3_UNDEFINED_MARKER => Ok(AmfValue::Undefined),
        AMF3_NULL_MARKER => Ok(AmfValue::Null),
        AMF3_FALSE_MARKER => Ok(AmfValue::Boolean(false)),
        AMF3_TRUE_MARKER => Ok(AmfValue::Boolean(true)),
        AMF3_INTEGER_MARKER => {
            let raw = read_u29(buf)?;
            // AMF3's "integer" type is logically signed over
            // [-2^28, 2^28-1], represented on the wire as a plain U29 whose
            // top bit (bit 28) is reinterpreted as a sign bit — included
            // for completeness even though every real value this server
            // ever reads back (transaction ids, small counts) is
            // non-negative and never needs the negative branch.
            let signed = if raw & 0x1000_0000 != 0 { raw as i32 - 0x2000_0000 } else { raw as i32 };
            Ok(AmfValue::Number(signed as f64))
        }
        AMF3_DOUBLE_MARKER => {
            require(buf, 8, "amf3 double")?;
            Ok(AmfValue::Number(buf.get_f64()))
        }
        AMF3_STRING_MARKER => Ok(AmfValue::String(decode_string_value(buf, ctx)?)),
        AMF3_XML_DOC_MARKER | AMF3_XML_MARKER => decode_xml_like(buf, ctx),
        AMF3_DATE_MARKER => decode_date(buf, ctx),
        AMF3_ARRAY_MARKER => decode_array(buf, ctx),
        AMF3_OBJECT_MARKER => decode_object(buf, ctx),
        AMF3_BYTE_ARRAY_MARKER => decode_byte_array(buf, ctx),
        AMF3_VECTOR_INT_MARKER
        | AMF3_VECTOR_UINT_MARKER
        | AMF3_VECTOR_DOUBLE_MARKER
        | AMF3_VECTOR_OBJECT_MARKER
        | AMF3_DICTIONARY_MARKER => {
            // A later AMF3 spec revision; no real RTMP live encoder emits
            // any of these five — rejected explicitly rather than silently
            // misparsed, same discipline as every other unsupported marker
            // in this codebase.
            anyhow::bail!("AMF3 decode: Vector/Dictionary types are not supported (marker 0x{marker:02x})")
        }
        other => anyhow::bail!("AMF3 decode: unsupported marker 0x{other:02x}"),
    }
}

/// Decodes exactly one AMF3-encoded value, starting a fresh set of
/// reference tables — for a full message body use `decode_all`, since
/// AMF3's reference tables are scoped to the whole body, not to one value.
pub fn decode(buf: &mut Bytes) -> anyhow::Result<AmfValue> {
    let mut ctx = DecodeCtx::new();
    decode_value(buf, &mut ctx)
}

pub fn decode_all(mut buf: Bytes) -> anyhow::Result<Vec<AmfValue>> {
    let mut ctx = DecodeCtx::new();
    let mut values = Vec::new();
    while !buf.is_empty() {
        values.push(decode_value(&mut buf, &mut ctx)?);
    }
    Ok(values)
}

/// Encodes one AMF3 value onto the end of `out` — the inverse of `decode`.
/// Never emits a back-reference: every value this server ever sends is
/// written fresh (every ref-or-literal header below always sets the
/// "literal follows" bit), which is fully spec-legal and means the encode
/// side needs no reference table at all — a deliberate complexity cut
/// mirroring `amf0.rs`'s identical choice.
pub fn encode(value: &AmfValue, out: &mut BytesMut) {
    match value {
        AmfValue::Undefined => out.put_u8(AMF3_UNDEFINED_MARKER),
        AmfValue::Null => out.put_u8(AMF3_NULL_MARKER),
        AmfValue::Boolean(false) => out.put_u8(AMF3_FALSE_MARKER),
        AmfValue::Boolean(true) => out.put_u8(AMF3_TRUE_MARKER),
        AmfValue::Number(n) => {
            // Always the AMF3 "double" type, never "integer" — every value
            // this server ever sends (transaction ids, status numbers)
            // fits safely as a double, sidestepping the integer type's
            // truncated 29-bit range entirely rather than needing a
            // runtime range check on the way out.
            out.put_u8(AMF3_DOUBLE_MARKER);
            out.put_f64(*n);
        }
        AmfValue::String(s) => {
            out.put_u8(AMF3_STRING_MARKER);
            encode_string_value(s, out);
        }
        AmfValue::XmlDoc(xml) => {
            out.put_u8(AMF3_XML_DOC_MARKER);
            encode_literal_bytes(xml.as_bytes(), out);
        }
        AmfValue::Date { millis } => {
            out.put_u8(AMF3_DATE_MARKER);
            write_u29(out, 1); // bit 0 = 1: literal value follows, not a reference
            out.put_f64(*millis);
        }
        AmfValue::StrictArray(items) => {
            out.put_u8(AMF3_ARRAY_MARKER);
            write_u29(out, ((items.len() as u32) << 1) | 1);
            encode_string_value("", out); // empty associative-part terminator
            for item in items {
                encode(item, out);
            }
        }
        AmfValue::Object(members) => {
            out.put_u8(AMF3_OBJECT_MARKER);
            encode_object_body("", members, out);
        }
        AmfValue::TypedObject { class_name, members } => {
            out.put_u8(AMF3_OBJECT_MARKER);
            encode_object_body(class_name, members, out);
        }
        AmfValue::ByteArray(bytes) => {
            out.put_u8(AMF3_BYTE_ARRAY_MARKER);
            encode_literal_bytes(bytes, out);
        }
    }
}

fn encode_string_value(s: &str, out: &mut BytesMut) {
    write_u29(out, ((s.len() as u32) << 1) | 1);
    out.put_slice(s.as_bytes());
}

fn encode_literal_bytes(bytes: &[u8], out: &mut BytesMut) {
    write_u29(out, ((bytes.len() as u32) << 1) | 1);
    out.put_slice(bytes);
}

/// Every object this server ever sends is a plain dynamic object with zero
/// sealed members — the same shape every AMF0 response already sends
/// today, just re-expressed in AMF3's trait format. Header bits: bit 0 = 1
/// (not a reference), bit 1 = 1 (a full trait definition follows, not a
/// trait reference), bit 2 = 0 (not externalizable), bit 3 = 1 (dynamic),
/// bits above that = 0 (zero sealed members).
fn encode_object_body(class_name: &str, members: &BTreeMap<String, AmfValue>, out: &mut BytesMut) {
    write_u29(out, 0b1011);
    encode_string_value(class_name, out);
    for (key, value) in members {
        encode_string_value(key, out);
        encode(value, out);
    }
    encode_string_value("", out); // terminates the dynamic member list
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
    fn roundtrips_undefined_null_and_booleans() {
        assert_eq!(roundtrip(AmfValue::Undefined), AmfValue::Undefined);
        assert_eq!(roundtrip(AmfValue::Null), AmfValue::Null);
        assert_eq!(roundtrip(AmfValue::Boolean(true)), AmfValue::Boolean(true));
        assert_eq!(roundtrip(AmfValue::Boolean(false)), AmfValue::Boolean(false));
    }

    #[test]
    fn roundtrips_a_double_including_a_negative_and_fractional_value() {
        assert_eq!(roundtrip(AmfValue::Number(-3.25)), AmfValue::Number(-3.25));
        assert_eq!(roundtrip(AmfValue::Number(1.0)), AmfValue::Number(1.0));
    }

    #[test]
    fn roundtrips_a_string() {
        assert_eq!(roundtrip(AmfValue::String("connect".to_string())), AmfValue::String("connect".to_string()));
    }

    #[test]
    fn roundtrips_an_empty_string() {
        // The empty string is spec-excluded from the string reference
        // table — worth its own test since that exclusion is an easy
        // detail to get backwards (indexing it, or crashing on a
        // zero-length reference lookup).
        assert_eq!(roundtrip(AmfValue::String(String::new())), AmfValue::String(String::new()));
    }

    #[test]
    fn roundtrips_a_dynamic_object() {
        let value = object([("app", AmfValue::String("live".to_string())), ("objectEncoding", AmfValue::Number(3.0))]);
        assert_eq!(roundtrip(value.clone()), value);
    }

    #[test]
    fn roundtrips_a_dense_array() {
        let value = AmfValue::StrictArray(vec![AmfValue::Number(1.0), AmfValue::String("two".to_string())]);
        assert_eq!(roundtrip(value.clone()), value);
    }

    #[test]
    fn roundtrips_a_date() {
        assert_eq!(roundtrip(AmfValue::Date { millis: 1_700_000_000_000.0 }), AmfValue::Date { millis: 1_700_000_000_000.0 });
    }

    #[test]
    fn roundtrips_an_xml_document_and_byte_array() {
        assert_eq!(roundtrip(AmfValue::XmlDoc("<a/>".to_string())), AmfValue::XmlDoc("<a/>".to_string()));
        assert_eq!(roundtrip(AmfValue::ByteArray(vec![1, 2, 3])), AmfValue::ByteArray(vec![1, 2, 3]));
    }

    /// Decodes the U29 integer type directly (this encoder never emits it —
    /// see `encode`'s own doc — so this is a hand-built wire fixture, not a
    /// round trip), including its 4-byte form to exercise the "last byte
    /// uses all 8 bits" special case.
    #[test]
    fn decodes_the_integer_type_including_its_4_byte_form() {
        let mut small = BytesMut::new();
        small.put_u8(AMF3_INTEGER_MARKER);
        small.put_u8(5); // U29 single-byte form: bit7=0, value=5
        assert_eq!(decode(&mut small.freeze()).unwrap(), AmfValue::Number(5.0));

        let mut large = BytesMut::new();
        large.put_u8(AMF3_INTEGER_MARKER);
        large.put_u8(0x81); // continuation bytes...
        large.put_u8(0x80);
        large.put_u8(0x80);
        large.put_u8(0x00); // ...4th byte carries all 8 bits: 1 shifted by 7+7+8 = 22
        assert_eq!(decode(&mut large.freeze()).unwrap(), AmfValue::Number((1u32 << 22) as f64));
    }

    /// A real encoder sends a string reference instead of re-encoding a
    /// repeated string — hand-built, since this encoder deliberately never
    /// emits references itself (see `encode`'s doc) — confirming
    /// `decode_all` resolves it to a real copy of the first string.
    #[test]
    fn resolves_a_string_reference_to_an_earlier_value_in_the_same_message() {
        let mut buf = BytesMut::new();
        buf.put_u8(AMF3_STRING_MARKER);
        encode_string_value("connect", &mut buf); // registers "connect" at index 0
        buf.put_u8(AMF3_STRING_MARKER);
        write_u29(&mut buf, 0); // bit0=0: reference, index 0

        let values = decode_all(buf.freeze()).unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0], AmfValue::String("connect".to_string()));
        assert_eq!(values[1], AmfValue::String("connect".to_string()));
    }

    #[test]
    fn resolves_an_object_reference_to_an_earlier_value_in_the_same_message() {
        let shared = object([("id", AmfValue::Number(1.0))]);
        let mut buf = BytesMut::new();
        encode(&shared, &mut buf); // object at reference index 0
        buf.put_u8(AMF3_OBJECT_MARKER);
        write_u29(&mut buf, 0); // bit0=0: reference, index 0

        let values = decode_all(buf.freeze()).unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0], shared);
        assert_eq!(values[1], shared);
    }

    #[test]
    fn rejects_vector_and_dictionary_markers_instead_of_misparsing_them() {
        let mut bytes = Bytes::from_static(&[AMF3_VECTOR_INT_MARKER]);
        assert!(decode(&mut bytes).is_err());
        let mut bytes = Bytes::from_static(&[AMF3_DICTIONARY_MARKER]);
        assert!(decode(&mut bytes).is_err());
    }

    #[test]
    fn rejects_an_externalizable_object_instead_of_misparsing_it() {
        let mut buf = BytesMut::new();
        buf.put_u8(AMF3_OBJECT_MARKER);
        write_u29(&mut buf, 0b0111); // bit0=1 literal, bit1=1 new traits, bit2=1 externalizable
        assert!(decode(&mut buf.freeze()).is_err());
    }

    #[test]
    fn rejects_a_populated_associative_array_instead_of_silently_dropping_it() {
        let mut buf = BytesMut::new();
        buf.put_u8(AMF3_ARRAY_MARKER);
        write_u29(&mut buf, 1); // dense count 0, literal
        encode_string_value("notEmpty", &mut buf); // a real associative key — unsupported
        assert!(decode(&mut buf.freeze()).is_err());
    }
}
