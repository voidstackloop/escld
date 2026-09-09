use rand::Rng;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const RTMP_VERSION: u8 = 3;
const HANDSHAKE_SIZE: usize = 1536;

/// The plain ("simple") RTMP handshake — no HMAC-SHA256 digest
/// challenge/response, unlike the "complex" handshake Adobe's own Flash
/// Media Server originated. Every real encoder this server needs to accept
/// (OBS, ffmpeg, and every other RTMP client in practice) falls back to, or
/// natively speaks, the simple handshake when a server doesn't itself
/// initiate the complex one — this is also what widely-deployed minimal
/// servers (e.g. node-media-server, nginx-rtmp) implement, not a corner cut
/// specific to this server.
///
/// Sequence (server side): read C0+C1, write S0+S1+S2, read C2. Values
/// inside C1/S1/S2 beyond their fixed-size shape are never validated — a
/// real digest-based handshake would cryptographically bind S2 to the
/// client's C1, but the simple handshake's only actual requirement is the
/// correct byte *sizes* at each step; content is unchecked by design.
pub async fn perform(socket: &mut TcpStream) -> anyhow::Result<()> {
    // C0 + C1
    let mut c0 = [0u8; 1];
    socket.read_exact(&mut c0).await?;
    if c0[0] != RTMP_VERSION {
        anyhow::bail!("unsupported RTMP version in C0: {}", c0[0]);
    }
    let mut c1 = [0u8; HANDSHAKE_SIZE];
    socket.read_exact(&mut c1).await?;

    // S0 + S1
    let mut s1 = [0u8; HANDSHAKE_SIZE];
    // Bytes 0..4: our own timestamp (0 is universally accepted — nothing
    // downstream of the handshake depends on this value). Bytes 4..8: must
    // be zero per spec. Bytes 8..1536: random, per spec's own suggestion.
    rand::rng().fill_bytes(&mut s1[8..]);
    socket.write_all(&[RTMP_VERSION]).await?;
    socket.write_all(&s1).await?;

    // S2 — echoes C1 verbatim. The spec's own suggested S2 shape is C1's
    // timestamp + the time S2 was sent + C1's random data; echoing C1
    // wholesale (timestamp included) is a widely-implemented simplification
    // that every client this server targets accepts, since the simple
    // handshake never actually checks S2 against what it sent as C1.
    socket.write_all(&c1).await?;

    // C2 — read and discard; the simple handshake doesn't validate it.
    let mut c2 = [0u8; HANDSHAKE_SIZE];
    socket.read_exact(&mut c2).await?;

    Ok(())
}
