use std::collections::HashMap;

use bytes::{Bytes, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt};

use super::message::{
    RtmpMessage, MSG_TYPE_ACKNOWLEDGEMENT, MSG_TYPE_SET_CHUNK_SIZE, MSG_TYPE_SET_PEER_BANDWIDTH,
    MSG_TYPE_USER_CONTROL, MSG_TYPE_WINDOW_ACK_SIZE,
};

const DEFAULT_CHUNK_SIZE: usize = 128;

/// Per-chunk-stream-id state the "compressed" chunk header formats (fmt 1-3)
/// rely on — each one only restates whichever header fields actually
/// changed since this chunk stream's last message, inheriting the rest from
/// here. One real RTMP connection multiplexes several chunk streams over
/// the single TCP connection (conventionally: 2 for protocol control
/// messages, 3 for command messages, a separate one per audio/video track),
/// each with its own independent header-inheritance state — this is why the
/// map is keyed by chunk stream id, not a single shared struct.
#[derive(Debug, Default)]
struct ChunkStreamState {
    timestamp: u32,
    timestamp_delta: u32,
    message_length: usize,
    message_type_id: u8,
    message_stream_id: u32,
    /// Whether this chunk stream's most recent header declared the 3-byte
    /// timestamp/delta field as the escape value 0xFFFFFF, meaning a real
    /// 4-byte timestamp follows immediately after the header. This has to
    /// be remembered per chunk stream (not just per-chunk) because a later
    /// fmt=3 chunk on the same stream inherits it silently — fmt=3 carries
    /// no timestamp field of its own to signal this from, so getting this
    /// wrong desyncs every following byte on the connection. The single
    /// most commonly-mis-implemented corner of the chunk format.
    has_extended_timestamp: bool,
    /// Bytes of the current message received so far, across however many
    /// chunks it's taken; empty exactly when a chunk stream is between
    /// messages (used to tell a fmt=3 "continuation" apart from a fmt=3
    /// "new message identical to the last one's header").
    partial: BytesMut,
}

/// Reassembles the RTMP chunk stream on one connection into whole messages.
/// Handles Set Chunk Size (message type 1) internally — updating how many
/// payload bytes it reads per chunk from that point on — and silently
/// discards the other protocol-control message types (Acknowledgement,
/// User Control, Window Ack Size, Set Peer Bandwidth) a client may send;
/// this server doesn't do bandwidth-limiting or heartbeat bookkeeping, so
/// there's nothing useful to do with them beyond not letting them desync
/// the framing.
pub struct ChunkReader {
    max_chunk_size: usize,
    streams: HashMap<u32, ChunkStreamState>,
}

impl Default for ChunkReader {
    fn default() -> Self {
        Self::new()
    }
}

impl ChunkReader {
    pub fn new() -> Self {
        Self {
            max_chunk_size: DEFAULT_CHUNK_SIZE,
            streams: HashMap::new(),
        }
    }

    /// Reads and returns the next application-level message (a command,
    /// audio, video, or data message) — transparently consuming as many
    /// chunks, across as many chunk stream ids, as needed, and silently
    /// looping past any protocol-control message along the way.
    pub async fn read_message<R: AsyncRead + Unpin>(&mut self, r: &mut R) -> anyhow::Result<RtmpMessage> {
        loop {
            let (fmt, csid) = self.read_basic_header(r).await?;
            self.read_message_header(r, fmt, csid).await?;

            let state = self
                .streams
                .get_mut(&csid)
                .expect("just inserted by read_message_header");
            let remaining = state.message_length - state.partial.len();
            let to_read = remaining.min(self.max_chunk_size);
            let mut chunk = vec![0u8; to_read];
            r.read_exact(&mut chunk).await?;
            state.partial.extend_from_slice(&chunk);

            if state.partial.len() < state.message_length {
                continue;
            }

            let type_id = state.message_type_id;
            let timestamp = state.timestamp;
            let stream_id = state.message_stream_id;
            let payload: Bytes = std::mem::take(&mut state.partial).freeze();

            match type_id {
                MSG_TYPE_SET_CHUNK_SIZE => {
                    if payload.len() >= 4 {
                        // Top bit is reserved/must be 0 per spec; masking it
                        // off is cheap insurance against a chunk size that
                        // would otherwise parse as a huge or negative value.
                        let size = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]) & 0x7FFF_FFFF;
                        if size > 0 {
                            self.max_chunk_size = size as usize;
                        }
                    }
                }
                MSG_TYPE_ACKNOWLEDGEMENT | MSG_TYPE_USER_CONTROL | MSG_TYPE_WINDOW_ACK_SIZE | MSG_TYPE_SET_PEER_BANDWIDTH => {
                    // Nothing to do — see the struct doc.
                }
                _ => {
                    return Ok(RtmpMessage {
                        type_id,
                        timestamp,
                        stream_id,
                        payload,
                    });
                }
            }
        }
    }

    /// The Basic Header: 1-3 bytes encoding the fmt (top 2 bits of the first
    /// byte) and the chunk stream id (everything else). Three sizes exist
    /// specifically so IDs 2-63 fit in the first byte alone (the overwhelmingly
    /// common case) while still allowing up to 65599 total chunk streams.
    async fn read_basic_header<R: AsyncRead + Unpin>(&self, r: &mut R) -> anyhow::Result<(u8, u32)> {
        let byte0 = r.read_u8().await?;
        let fmt = byte0 >> 6;
        let csid = match byte0 & 0x3F {
            0 => {
                let b = r.read_u8().await?;
                64 + b as u32
            }
            1 => {
                let b1 = r.read_u8().await?;
                let b2 = r.read_u8().await?;
                // Little-endian 16-bit value, per spec — the one byte order
                // exception in the chunk header format itself (the message
                // header's own multi-byte fields are big-endian, except the
                // message stream id, which is its own separate exception —
                // see read_message_header's fmt=0 arm).
                64 + (b1 as u32) + (b2 as u32) * 256
            }
            n => n as u32,
        };
        Ok((fmt, csid))
    }

    /// The Message Header: 11, 7, 3, or 0 bytes depending on fmt, each
    /// restating progressively fewer fields than fmt=0's full header —
    /// every omitted field is inherited from this chunk stream's last
    /// message (see `ChunkStreamState`). Ends by ensuring an entry exists
    /// in `self.streams` for `csid`, its `message_length`/`message_type_id`/
    /// `message_stream_id`/`timestamp` fully resolved for the chunk about
    /// to be read.
    async fn read_message_header<R: AsyncRead + Unpin>(&mut self, r: &mut R, fmt: u8, csid: u32) -> anyhow::Result<()> {
        match fmt {
            0 => {
                let ts_field = read_u24_be(r).await?;
                let length = read_u24_be(r).await? as usize;
                let type_id = r.read_u8().await?;
                // Message stream id is little-endian — see read_basic_header's
                // comment on the chunk stream id's own byte order.
                let stream_id = r.read_u32_le().await?;
                let (timestamp, has_extended_timestamp) = resolve_timestamp(r, ts_field).await?;

                self.streams.insert(
                    csid,
                    ChunkStreamState {
                        timestamp,
                        timestamp_delta: 0,
                        message_length: length,
                        message_type_id: type_id,
                        message_stream_id: stream_id,
                        has_extended_timestamp,
                        partial: BytesMut::new(),
                    },
                );
            }
            1 => {
                let delta_field = read_u24_be(r).await?;
                let length = read_u24_be(r).await? as usize;
                let type_id = r.read_u8().await?;
                let (delta, has_extended_timestamp) = resolve_timestamp(r, delta_field).await?;

                let state = self.streams.entry(csid).or_default();
                state.timestamp = state.timestamp.wrapping_add(delta);
                state.timestamp_delta = delta;
                state.message_length = length;
                state.message_type_id = type_id;
                state.has_extended_timestamp = has_extended_timestamp;
                state.partial.clear();
            }
            2 => {
                let delta_field = read_u24_be(r).await?;
                let (delta, has_extended_timestamp) = resolve_timestamp(r, delta_field).await?;

                let state = self.streams.entry(csid).or_default();
                state.timestamp = state.timestamp.wrapping_add(delta);
                state.timestamp_delta = delta;
                state.has_extended_timestamp = has_extended_timestamp;
                state.partial.clear();
            }
            3 => {
                let state = self.streams.entry(csid).or_default();
                // A fmt=3 chunk carries no timestamp field of its own — but
                // if this chunk stream's last real header declared an
                // extended timestamp, every fmt=3 chunk on it (continuation
                // *or* a new message reusing the same header) still carries
                // that same 4-byte field and it must be consumed here, or
                // every following byte on the connection desyncs.
                if state.has_extended_timestamp {
                    read_u32_be(r).await?;
                }
                if state.partial.is_empty() {
                    // Starting a new message whose header is identical to
                    // the previous one, delta included (a legal encoder
                    // optimization) — length/type/stream id already carried
                    // over from last time; only the timestamp still needs
                    // advancing by the same delta again.
                    state.timestamp = state.timestamp.wrapping_add(state.timestamp_delta);
                }
                // Else: a continuation chunk of a message already in
                // progress — nothing about the header state changes.
            }
            _ => unreachable!("fmt is always 0-3, derived from 2 bits"),
        }
        Ok(())
    }
}

/// A message/chunk header's timestamp (or timestamp-delta) field is 3 bytes,
/// *unless* the value doesn't fit, in which case the field is set to the
/// escape value 0xFFFFFF and the real 32-bit value immediately follows as
/// an explicit 4-byte extended timestamp. Shared by the fmt=0/1/2 header
/// parsers above since all three have exactly this same escape shape,
/// differing only in whether the 3-byte field is an absolute value (fmt=0)
/// or a delta (fmt=1/2) — irrelevant to resolving the escape itself.
async fn resolve_timestamp<R: AsyncRead + Unpin>(r: &mut R, field: u32) -> anyhow::Result<(u32, bool)> {
    if field == 0x00FF_FFFF {
        Ok((read_u32_be(r).await?, true))
    } else {
        Ok((field, false))
    }
}

async fn read_u24_be<R: AsyncRead + Unpin>(r: &mut R) -> anyhow::Result<u32> {
    let mut buf = [0u8; 3];
    r.read_exact(&mut buf).await?;
    Ok((buf[0] as u32) << 16 | (buf[1] as u32) << 8 | buf[2] as u32)
}

async fn read_u32_be<R: AsyncRead + Unpin>(r: &mut R) -> anyhow::Result<u32> {
    let mut buf = [0u8; 4];
    r.read_exact(&mut buf).await?;
    Ok(u32::from_be_bytes(buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hand-encodes one fmt=0 chunk header (basic header + full 11-byte
    /// message header) — independent of, not calling, `writer.rs`'s own
    /// encoder, so a bug shared between production encode and this decode
    /// test wouldn't silently cancel out.
    fn fmt0_header(csid: u32, timestamp: u32, length: u32, type_id: u8, stream_id: u32) -> Vec<u8> {
        assert!(csid < 64, "test helper only handles the 1-byte basic header form");
        let mut out = vec![(0u8 << 6) | csid as u8];
        out.extend_from_slice(&timestamp.to_be_bytes()[1..]); // low 3 bytes, big-endian
        out.extend_from_slice(&length.to_be_bytes()[1..]);
        out.push(type_id);
        out.extend_from_slice(&stream_id.to_le_bytes()); // message stream id is little-endian
        out
    }

    fn fmt3_header(csid: u32) -> Vec<u8> {
        vec![(3u8 << 6) | csid as u8]
    }

    #[tokio::test]
    async fn reads_a_single_chunk_message() {
        let payload = b"hello";
        let mut bytes = fmt0_header(3, 0, payload.len() as u32, 20, 0);
        bytes.extend_from_slice(payload);

        let mut cursor: &[u8] = &bytes;
        let mut reader = ChunkReader::new();
        let message = reader.read_message(&mut cursor).await.unwrap();

        assert_eq!(message.type_id, 20);
        assert_eq!(message.stream_id, 0);
        assert_eq!(&message.payload[..], payload);
    }

    #[tokio::test]
    async fn reassembles_a_message_split_across_the_default_chunk_size() {
        // 200 bytes of payload, default chunk size 128 — must arrive as a
        // fmt=0 chunk carrying the first 128 bytes, then a fmt=3
        // continuation carrying the remaining 72, and be handed back to the
        // caller as one contiguous 200-byte message.
        let payload: Vec<u8> = (0..200u32).map(|i| (i % 256) as u8).collect();
        let mut bytes = fmt0_header(3, 0, payload.len() as u32, 9, 1);
        bytes.extend_from_slice(&payload[..128]);
        bytes.extend_from_slice(&fmt3_header(3));
        bytes.extend_from_slice(&payload[128..]);

        let mut cursor: &[u8] = &bytes;
        let mut reader = ChunkReader::new();
        let message = reader.read_message(&mut cursor).await.unwrap();

        assert_eq!(message.type_id, 9);
        assert_eq!(message.payload.len(), 200);
        assert_eq!(&message.payload[..], &payload[..]);
    }

    #[tokio::test]
    async fn a_set_chunk_size_message_is_consumed_internally_and_changes_how_the_next_message_is_split() {
        // Set Chunk Size (type 1): a 4-byte big-endian value as the whole
        // message body, conventionally on chunk stream id 2.
        let mut bytes = fmt0_header(2, 0, 4, MSG_TYPE_SET_CHUNK_SIZE, 0);
        bytes.extend_from_slice(&5u32.to_be_bytes());

        // A 10-byte message that only reassembles correctly if the reader
        // actually applied the new chunk size of 5 above: fmt=0 chunk
        // carrying exactly 5 bytes, then one fmt=3 continuation for the
        // remaining 5 — if the reader were still using the default 128,
        // this same byte layout would be malformed (the fmt=0 chunk would
        // be read as if it carried the full 10 bytes, consuming into what
        // this test intends as the fmt=3 continuation's own basic header
        // byte, and reassembly would either fail or produce garbage).
        let payload = b"0123456789";
        bytes.extend_from_slice(&fmt0_header(3, 0, payload.len() as u32, 8, 0));
        bytes.extend_from_slice(&payload[..5]);
        bytes.extend_from_slice(&fmt3_header(3));
        bytes.extend_from_slice(&payload[5..]);

        let mut cursor: &[u8] = &bytes;
        let mut reader = ChunkReader::new();
        let message = reader.read_message(&mut cursor).await.unwrap();

        // The Set Chunk Size message itself must never be surfaced as an
        // application message — only the real one after it.
        assert_eq!(message.type_id, 8);
        assert_eq!(&message.payload[..], payload);
    }

    #[tokio::test]
    async fn resolves_an_extended_timestamp_when_the_3_byte_field_is_the_escape_value() {
        let payload = b"x";
        let mut bytes = vec![(0u8 << 6) | 3u8]; // basic header, csid 3, fmt 0
        bytes.extend_from_slice(&[0xFF, 0xFF, 0xFF]); // timestamp field = escape value
        bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes()[1..]);
        bytes.push(20);
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&500_000u32.to_be_bytes()); // the real, extended timestamp
        bytes.extend_from_slice(payload);

        let mut cursor: &[u8] = &bytes;
        let mut reader = ChunkReader::new();
        let message = reader.read_message(&mut cursor).await.unwrap();

        assert_eq!(message.timestamp, 500_000);
    }
}
