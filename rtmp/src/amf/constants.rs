pub const AMF0_NUMBER_MARKER: u8 = 0x00;
pub const AMF0_BOOLEAN_MARKER: u8 = 0x01;
pub const AMF0_STRING_MARKER: u8 = 0x02;
pub const AMF0_OBJECT_MARKER: u8 = 0x03;
pub const AMF0_MOVIECLIP_MARKER: u8 = 0x04;
pub const AMF0_NULL_MARKER: u8 = 0x05;
pub const AMF0_UNDEFINED_MARKER: u8 = 0x06;
pub const AMF0_REFERENCE_MARKER: u8 = 0x07;
pub const AMF0_ECMA_ARRAY_MARKER: u8 = 0x08;
pub const AMF0_OBJECT_END_MARKER: u8 = 0x09;
pub const AMF0_STRICT_ARRAY_MARKER: u8 = 0x0a;
pub const AMF0_DATE_MARKER: u8 = 0x0b;
pub const AMF0_LONG_STRING_MARKER: u8 = 0x0c;
pub const AMF0_UNSUPPORTED_MARKER: u8 = 0x0d;
pub const AMF0_RECORDSET_MARKER: u8 = 0x0e;
pub const AMF0_XML_DOCUMENT_MARKER: u8 = 0x0f;
pub const AMF0_TYPED_OBJECT_MARKER: u8 = 0x10;
pub const AMF0_BOOLEAN_FALSE: u8 = 0x00;
pub const AMF0_BOOLEAN_TRUE: u8 = 0x01;

// AMF3 markers (distinct numbering from AMF0 above — same byte values mean
// different things depending on which codec is decoding).
pub const AMF3_UNDEFINED_MARKER: u8 = 0x00;
pub const AMF3_NULL_MARKER: u8 = 0x01;
pub const AMF3_FALSE_MARKER: u8 = 0x02;
pub const AMF3_TRUE_MARKER: u8 = 0x03;
pub const AMF3_INTEGER_MARKER: u8 = 0x04;
pub const AMF3_DOUBLE_MARKER: u8 = 0x05;
pub const AMF3_STRING_MARKER: u8 = 0x06;
pub const AMF3_XML_DOC_MARKER: u8 = 0x07;
pub const AMF3_DATE_MARKER: u8 = 0x08;
pub const AMF3_ARRAY_MARKER: u8 = 0x09;
pub const AMF3_OBJECT_MARKER: u8 = 0x0a;
pub const AMF3_XML_MARKER: u8 = 0x0b;
pub const AMF3_BYTE_ARRAY_MARKER: u8 = 0x0c;
// Added by a later AMF3 spec revision; deliberately unimplemented (see
// amf3.rs) — no real RTMP live encoder emits any of these five.
pub const AMF3_VECTOR_INT_MARKER: u8 = 0x0d;
pub const AMF3_VECTOR_UINT_MARKER: u8 = 0x0e;
pub const AMF3_VECTOR_DOUBLE_MARKER: u8 = 0x0f;
pub const AMF3_VECTOR_OBJECT_MARKER: u8 = 0x10;
pub const AMF3_DICTIONARY_MARKER: u8 = 0x11;
