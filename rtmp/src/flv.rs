use bytes::{BufMut, BytesMut};

/// FLV tag type ids — deliberately identical numeric values to the RTMP
/// message type ids for audio (8)/video (9)/data (18), since FLV's tag
/// format is literally what RTMP's own message payloads for those types
/// already are: an FLV tag is just an RTMP audio/video/data message payload
/// with a small fixed header restating its own size/timestamp/type. This is
/// exactly why re-muxing RTMP into FLV is a byte-for-byte transcription, not
/// a real transcode — see write_tag.
pub const TAG_TYPE_AUDIO: u8 = 8;
pub const TAG_TYPE_VIDEO: u8 = 9;
pub const TAG_TYPE_SCRIPT_DATA: u8 = 18;

/// Writes the 9-byte FLV file header plus the mandatory 4-byte
/// "PreviousTagSize0" (always 0 — there is no tag before the first one).
/// Call this exactly once per output stream, before any `write_tag` call.
pub fn write_header(out: &mut BytesMut, has_audio: bool, has_video: bool) {
    out.put_slice(b"FLV");
    out.put_u8(1); // version
    let mut flags = 0u8;
    if has_audio {
        flags |= 0x04;
    }
    if has_video {
        flags |= 0x01;
    }
    out.put_u8(flags);
    out.put_u32(9); // header size, always 9 for this version
    out.put_u32(0); // PreviousTagSize0
}

/// Writes one FLV tag: an 11-byte header (type, 24-bit data size, 24-bit
/// timestamp + 8-bit timestamp-extension byte, 24-bit stream id — always 0),
/// the payload verbatim, then a trailing 4-byte "PreviousTagSize" (used by
/// FLV readers seeking backward through the file; ffmpeg's own FLV demuxer
/// relies on it). `timestamp_ms` is carried through directly from the RTMP
/// message it came from — this function does no timestamp rebasing/offsetting
/// of its own, so the first tag's timestamp is whatever the encoder itself
/// started counting from, not necessarily 0.
pub fn write_tag(out: &mut BytesMut, tag_type: u8, timestamp_ms: u32, payload: &[u8]) {
    let data_size = payload.len() as u32;

    out.put_u8(tag_type);
    put_u24_be(out, data_size);
    // FLV timestamps are 24 bits plus one extra byte carrying the high 8
    // bits — split out because FLV predates needing a full 32-bit range and
    // this awkward shape is how it was bolted on, not something this writer
    // gets to choose.
    put_u24_be(out, timestamp_ms & 0x00FF_FFFF);
    out.put_u8(((timestamp_ms >> 24) & 0xFF) as u8);
    put_u24_be(out, 0); // stream id, always 0 in FLV

    out.put_slice(payload);
    out.put_u32(11 + data_size);
}

fn put_u24_be(out: &mut BytesMut, value: u32) {
    out.put_u8(((value >> 16) & 0xFF) as u8);
    out.put_u8(((value >> 8) & 0xFF) as u8);
    out.put_u8((value & 0xFF) as u8);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_exact_documented_flv_header_shape() {
        let mut buf = BytesMut::new();
        write_header(&mut buf, true, true);
        assert_eq!(
            buf.as_ref(),
            &[b'F', b'L', b'V', 1, 0x05, 0, 0, 0, 9, 0, 0, 0, 0],
            "F,L,V,version=1,flags=0x05(audio|video),headerSize=9(u32),PreviousTagSize0=0(u32)"
        );
    }

    #[test]
    fn video_only_header_sets_only_the_video_flag_bit() {
        let mut buf = BytesMut::new();
        write_header(&mut buf, false, true);
        assert_eq!(buf[4], 0x01, "video-only flag byte should be 0x01, not audio's 0x04 or both");
    }

    #[test]
    fn writes_a_tag_with_the_exact_documented_11_byte_header_and_trailing_size() {
        let mut buf = BytesMut::new();
        let payload = [0xAA, 0xBB, 0xCC];
        write_tag(&mut buf, TAG_TYPE_VIDEO, 0x0102_0304, &payload);

        let mut expected = vec![
            TAG_TYPE_VIDEO,
            0x00, 0x00, 0x03, // data size = 3, 3-byte big-endian
            0x02, 0x03, 0x04, // low 24 bits of timestamp, big-endian
            0x01, // extended timestamp byte = the high 8 bits
            0x00, 0x00, 0x00, // stream id, always 0
        ];
        expected.extend_from_slice(&payload);
        expected.extend_from_slice(&(11u32 + 3).to_be_bytes()); // PreviousTagSize

        assert_eq!(buf.as_ref(), expected.as_slice());
    }
}
