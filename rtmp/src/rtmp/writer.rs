use bytes::{BufMut, BytesMut};
use tokio::io::{AsyncWrite, AsyncWriteExt};

/// This server always writes its own outgoing messages under a fixed 128-byte
/// chunk size (RTMP's own default, valid without ever announcing it) —
/// every message this server ever sends (protocol-control replies, small
/// AMF0 command responses) is short, so there was no reason to negotiate a
/// larger one just for the write direction. Chunk size is independent per
/// direction: this has no bearing on how large a chunk size *the client's*
/// own messages use (see chunk.rs, which tracks that separately, entirely
/// driven by whatever the client itself declares).
const WRITE_CHUNK_SIZE: usize = 128;

/// Chunk stream id 2 is the conventional id for protocol-control messages
/// (Set Chunk Size, Window Ack Size, Set Peer Bandwidth, User Control) —
/// not load-bearing (a client must accept these on any chunk stream id),
/// but matches what real servers emit, which is one less way to look
/// unusual to a client's own parser.
pub const CONTROL_CHUNK_STREAM_ID: u32 = 2;
/// Chunk stream id 3 is the equally-conventional id for command messages
/// (connect/createStream/publish responses).
pub const COMMAND_CHUNK_STREAM_ID: u32 = 3;

/// Encodes and writes one full RTMP message, splitting it into a leading
/// fmt=0 chunk (the complete 11-byte message header) followed by as many
/// fmt=3 continuation chunks (1-byte basic header only) as needed once the
/// payload exceeds `WRITE_CHUNK_SIZE` — the inverse of `ChunkReader`, but
/// only ever needs to produce fmt=0/fmt=3, never the compressed fmt=1/2
/// forms, since nothing here sends enough distinct same-header messages in
/// a row for that compression to be worth implementing.
pub async fn write_message<W: AsyncWrite + Unpin>(
    w: &mut W,
    chunk_stream_id: u32,
    type_id: u8,
    timestamp: u32,
    message_stream_id: u32,
    payload: &[u8],
) -> anyhow::Result<()> {
    let mut out = BytesMut::with_capacity(payload.len() + 16);

    write_basic_header(&mut out, 0, chunk_stream_id);
    write_u24_be(&mut out, timestamp.min(0x00FF_FFFE));
    write_u24_be(&mut out, payload.len() as u32);
    out.put_u8(type_id);
    out.put_u32_le(message_stream_id);

    let mut remaining = payload;
    let first = remaining.len().min(WRITE_CHUNK_SIZE);
    out.put_slice(&remaining[..first]);
    remaining = &remaining[first..];

    while !remaining.is_empty() {
        write_basic_header(&mut out, 3, chunk_stream_id);
        let n = remaining.len().min(WRITE_CHUNK_SIZE);
        out.put_slice(&remaining[..n]);
        remaining = &remaining[n..];
    }

    w.write_all(&out).await?;
    Ok(())
}

fn write_basic_header(out: &mut BytesMut, fmt: u8, csid: u32) {
    // Only the 1-byte form is ever needed here — every chunk stream id this
    // server itself allocates (CONTROL/COMMAND above, plus small integers
    // for the rare case a caller wants more) comfortably fits in 6 bits.
    debug_assert!(csid < 64, "chunk stream id {csid} needs the multi-byte basic header form, not implemented here");
    out.put_u8((fmt << 6) | csid as u8);
}

fn write_u24_be(out: &mut BytesMut, value: u32) {
    out.put_u8(((value >> 16) & 0xFF) as u8);
    out.put_u8(((value >> 8) & 0xFF) as u8);
    out.put_u8((value & 0xFF) as u8);
}

/// Window Acknowledgement Size (message type 5) — tells the client how many
/// bytes to send before it should expect an Acknowledgement back. This
/// server never actually reads the client's Acknowledgements or sends its
/// own (see chunk.rs — both are just silently accepted and discarded), but
/// OBS and ffmpeg both expect *some* value here as part of the standard
/// post-connect handshake and get confused by its total absence, so it's
/// sent with a generous, arbitrary size that in practice is never reached
/// at this app's expected single-encoder-per-connection bitrates.
pub async fn write_window_ack_size<W: AsyncWrite + Unpin>(w: &mut W, size: u32) -> anyhow::Result<()> {
    let mut payload = BytesMut::with_capacity(4);
    payload.put_u32(size);
    write_message(w, CONTROL_CHUNK_STREAM_ID, super::message::MSG_TYPE_WINDOW_ACK_SIZE, 0, 0, &payload).await
}

/// Set Peer Bandwidth (message type 6) — paired with Window Ack Size in
/// every real server's connect response; limit type 2 ("Dynamic") is the
/// least prescriptive of the three defined values and matches what this
/// server actually does (nothing) with the client's own send rate.
pub async fn write_set_peer_bandwidth<W: AsyncWrite + Unpin>(w: &mut W, size: u32) -> anyhow::Result<()> {
    let mut payload = BytesMut::with_capacity(5);
    payload.put_u32(size);
    payload.put_u8(2);
    write_message(w, CONTROL_CHUNK_STREAM_ID, super::message::MSG_TYPE_SET_PEER_BANDWIDTH, 0, 0, &payload).await
}

/// User Control Message (type 4), "Stream Begin" event (event type 0) —
/// the last of the three fixed messages every client expects immediately
/// after a successful `connect`, signaling that message stream 0 (the
/// connection's own control stream) is now active.
pub async fn write_stream_begin<W: AsyncWrite + Unpin>(w: &mut W, stream_id: u32) -> anyhow::Result<()> {
    let mut payload = BytesMut::with_capacity(6);
    payload.put_u16(0); // event type 0 = Stream Begin
    payload.put_u32(stream_id);
    write_message(w, CONTROL_CHUNK_STREAM_ID, super::message::MSG_TYPE_USER_CONTROL, 0, 0, &payload).await
}
