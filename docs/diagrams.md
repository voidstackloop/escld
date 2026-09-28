# escld diagrams

Rendered copies live in [`docs/images/`](images/). The prose behind each
diagram: [ARCHITECTURE.md](ARCHITECTURE.md), [WS_SFU.md](WS_SFU.md),
[RTMP.md](RTMP.md), [INFRASTRUCTURE.md](INFRASTRUCTURE.md).

## System architecture

Eight services around shared Postgres and a few purpose-specific stores.
Production shapes are shown (ALB, SQS, MSK, S3/CloudFront, Cognito); locally,
`docker-compose.yaml` emulates DynamoDB and SQS and runs real Postgres, Redis,
Elasticsearch and Kafka, but still uses the hosted Cognito pool.

![escld architecture](images/diagram-architecture.svg)

```mermaid
flowchart TB
    U(["Browser"])
    ENC(["OBS / ffmpeg encoder"])

    subgraph EDGE["Edge · auth"]
        direction LR
        CF["CloudFront<br/>SPA · media · HLS"]
        ALB["ALB<br/>/api/* · /analytics/* · /hls/*"]
        COG["Cognito<br/>JWT · admin/moderator groups"]
    end

    subgraph SYNC["Request path"]
        direction LR
        FE["frontend<br/>React 19 · Vite"]
        BE["backend<br/>Java 25 · Spring Boot 4"]
        AN["analytics<br/>Node · trending API"]
        SFU["ws-sfu<br/>Rust · Socket.IO · mediasoup<br/>chat + WebRTC calls"]
        RT["rtmp<br/>Rust · RTMP → HLS"]
    end

    subgraph ASYNC["Async"]
        direction LR
        SQT[["SQS transcode-jobs"]]
        SQP[["SQS post-events"]]
        K[["Kafka / MSK<br/>warehouse · live.*"]]
        W["worker<br/>ffmpeg transcode"]
        FW["feed-worker<br/>embed · index · fan-out"]
        BQ["bq-sink → BigQuery"]
    end

    subgraph DATA["Stores"]
        direction LR
        PG[("Postgres<br/>users · posts · outbox")]
        DDB[("DynamoDB<br/>feeds · graph · chats")]
        ES[("Elasticsearch 9")]
        RD[("Redis<br/>cache · pub/sub")]
        S3[("S3<br/>media · HLS")]
    end

    U --> CF --> FE
    U -- "REST + JWT" --> ALB
    U -- "Socket.IO · WebRTC UDP" --> SFU
    U -. "sign in" .-> COG
    ENC -- "RTMP :1935" --> RT
    ALB --> BE & AN

    BE --> SQT --> W
    BE --> SQP --> FW
    BE -- "outbox relay" --> K --> BQ
    K -- "live.started/ended" --> SFU
    RT -- "live.ended" --> K

    BE --> PG & DDB & ES & RD
    RD -- "analytics-events" --> AN
    W --> S3
    FW --> ES & DDB
    SFU --> DDB
    RT --> PG & S3
    S3 --> CF
```

## Video call setup (mediasoup via Socket.IO)

All signaling is custom Socket.IO events; media flows over UDP directly to
the SFU. One mediasoup Router per conversation, created on the first join.

![call flow](images/diagram-call-sequence.svg)

```mermaid
sequenceDiagram
    autonumber
    participant A as Alice (browser)
    participant S as ws-sfu
    participant B as Bob (browser)
    participant D as DynamoDB conversations

    A->>S: connect (Cognito access token)
    S->>S: verify JWT (JWKS) → Postgres user → Identity
    A->>S: call:join {conversationId}
    S->>D: is Alice a participant?
    S-->>A: router RTP capabilities, existing producers, recording state
    A->>S: call:createTransport (send) → call:connectTransport (DTLS)
    A->>S: call:produce (mic, camera)
    S-->>B: call:newProducer
    B->>S: call:createTransport (recv) → call:connectTransport
    B->>S: call:consume (Alice's producer)
    S-->>B: consumer (paused)
    B->>S: call:resumeConsumer
    A-)S: RTP over UDP 40000-40019
    S-)B: forwarded RTP (SFU, no mixing)
    A->>S: call:pauseProducer (mute)
    S-->>B: call:producerStateChanged
    B->>S: call:leave
    S-->>A: call:peerLeft (room torn down when empty)
```

## Going live: RTMP → HLS pipeline

![rtmp pipeline](images/diagram-rtmp-hls.svg)

```mermaid
flowchart LR
    subgraph APP["In the app"]
        K1["POST /api/v1/live/stream-key"]
        K2["POST /api/v1/live/streams<br/>creates LIVE post"]
    end

    ENC["OBS / ffmpeg<br/>rtmp://host:1935/live/&lt;streamKey&gt;"]

    subgraph RTMP["rtmp service (Rust, tokio)"]
        HS["handshake<br/>C0/C1 → S0/S1/S2 → C2"]
        CMD["connect · createStream · publish<br/>AMF0 / AMF3"]
        AUTH{"stream key valid<br/>and stream announced?"}
        FLV["re-mux A/V messages<br/>to FLV tags"]
        FF["ffmpeg -c copy<br/>fMP4 HLS, 1s segments"]
        DISK[("local HLS dir")]
        SYNC["s3_sync<br/>poll every 100ms"]
        HTTP["/hls/* fallback route"]
    end

    PG[("Postgres<br/>users.stream_key · posts")]
    S3[("S3 live/&lt;key&gt;/")]
    CF["CloudFront<br/>m3u8 TTL ≤ 1s"]
    V(["Viewers<br/>HLS player"])
    K[["Kafka live.ended"]]
    SFU["ws-sfu<br/>feed:liveEnded push"]

    K1 --> K2
    K2 --> PG
    ENC --> HS --> CMD --> AUTH
    AUTH -- "lookup" --> PG
    AUTH -- "reject" --> X(["connection closed"])
    AUTH -- "ok" --> FLV --> FF --> DISK
    DISK --> SYNC --> S3 --> CF --> V
    DISK --> HTTP
    CMD -. "encoder disconnects" .-> END["mark post ENDED<br/>SIGINT ffmpeg → #EXT-X-ENDLIST<br/>final S3 sync"]
    END --> PG
    END --> K --> SFU
```
