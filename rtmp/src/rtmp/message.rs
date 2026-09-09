use bytes::Bytes;

pub const MSG_TYPE_SET_CHUNK_SIZE: u8 = 1;
pub const MSG_TYPE_ACKNOWLEDGEMENT: u8 = 3;
pub const MSG_TYPE_USER_CONTROL: u8 = 4;
pub const MSG_TYPE_WINDOW_ACK_SIZE: u8 = 5;
pub const MSG_TYPE_SET_PEER_BANDWIDTH: u8 = 6;
pub const MSG_TYPE_AUDIO: u8 = 8;
pub const MSG_TYPE_VIDEO: u8 = 9;
pub const MSG_TYPE_DATA_AMF0: u8 = 18;
pub const MSG_TYPE_DATA_AMF3: u8 = 15;
pub const MSG_TYPE_COMMAND_AMF0: u8 = 20;
pub const MSG_TYPE_COMMAND_AMF3: u8 = 17;

/// One fully-reassembled RTMP message — the unit `ChunkReader` produces and
/// the session loop dispatches on. Chunking is purely a wire-level framing
/// detail below this; nothing above `ChunkReader` ever sees a partial
/// message or needs to know how many chunks it took to arrive.
#[derive(Debug, Clone)]
pub struct RtmpMessage {
    pub type_id: u8,
    pub timestamp: u32,
    pub stream_id: u32,
    pub payload: Bytes,
}
