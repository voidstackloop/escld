# Pinned to 1.94 for the same reason as ws-sfu/Dockerfile: sqlx 0.9 requires
# rustc >= 1.94.
FROM rust:1.94-bookworm AS build
# rdkafka's build script compiles librdkafka from source via cmake (see
# Cargo.toml's own doc comment on the rdkafka dependency) - cmake plus these
# dev headers are what that compile needs; libcurl4-openssl-dev specifically
# because librdkafka's config source unconditionally includes curl/curl.h
# even with the WITH_CURL cmake flag off (confirmed by a real local build
# failure, not assumed from docs).
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake libssl-dev zlib1g-dev libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
# ffmpeg: remuxes the RTMP publish into live HLS (see src/hls.rs) - the one
# real runtime dependency this service has, same as worker/'s and ws-sfu's
# own images. libssl3/zlib1g/libcurl4: the dynamically-linked runtime
# counterparts of the builder stage's rdkafka dev headers above - librdkafka
# itself is statically linked into the binary, these are its own further
# runtime dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget ffmpeg libssl3 zlib1g libcurl4 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/rtmp ./rtmp
EXPOSE 1935
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:4001/health || exit 1
CMD ["./rtmp"]
