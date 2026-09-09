use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Drives `rtmp::rtmp::handshake::perform` (the server side) against a real
/// TCP loopback connection whose client side is hand-driven in this same
/// test — not a mock, an actual two-socket handshake over the real OS
/// networking stack. Proves the exact byte shapes (C0 version byte, C1/S1/S2
/// sizes, the read/write ordering) line up well enough for a real client to
/// complete the handshake, which is the part of RTMP most sensitive to a
/// single off-by-one.
#[tokio::test]
async fn completes_a_real_simple_handshake_over_loopback() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        rtmp::rtmp::handshake::perform(&mut socket).await
    });

    let mut client = TcpStream::connect(addr).await.unwrap();

    // C0 + C1 — version 3, then 1536 bytes (an encoder would send real
    // timestamp/random data here; zeros are equally valid wire-format-wise,
    // since the simple handshake never validates C1's content).
    client.write_all(&[3]).await.unwrap();
    client.write_all(&[0u8; 1536]).await.unwrap();

    // S0 + S1 + S2
    let mut s0 = [0u8; 1];
    client.read_exact(&mut s0).await.unwrap();
    assert_eq!(s0[0], 3, "server must reply with RTMP version 3 in S0");

    let mut s1 = [0u8; 1536];
    client.read_exact(&mut s1).await.unwrap();

    let mut s2 = [0u8; 1536];
    client.read_exact(&mut s2).await.unwrap();

    // C2 — the client's own final handshake message.
    client.write_all(&[0u8; 1536]).await.unwrap();

    let result = tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .expect("server task did not finish in time")
        .expect("server task panicked");

    assert!(result.is_ok(), "handshake::perform returned an error: {:?}", result.err());
}

/// A truncated/garbage handshake (wrong version byte) must be rejected, not
/// silently accepted — a real defensive check, not just "the happy path
/// works".
#[tokio::test]
async fn rejects_an_unsupported_handshake_version() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        rtmp::rtmp::handshake::perform(&mut socket).await
    });

    let mut client = TcpStream::connect(addr).await.unwrap();
    client.write_all(&[99]).await.unwrap(); // not RTMP version 3
    client.write_all(&[0u8; 1536]).await.unwrap();

    let result = tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .expect("server task did not finish in time")
        .expect("server task panicked");

    assert!(result.is_err(), "handshake::perform should reject an unsupported version byte");
}
