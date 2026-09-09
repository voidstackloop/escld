# Debian-based, not Alpine/musl - mediasoup's C++ worker build assumes a
# standard glibc + apt environment (its build script pip-installs its own
# pinned meson/ninja, so those don't need to be apt packages here). Pinned to
# 1.94 specifically since sqlx 0.9 requires rustc >= 1.94.
FROM rust:1.94-bookworm AS build
# cmake/libssl-dev/zlib1g-dev/libcurl4-openssl-dev: rdkafka's build script
# compiles librdkafka from source via cmake (see Cargo.toml's own doc
# comment on the rdkafka dependency, added for the live-feed Kafka
# consumer) - libcurl4-openssl-dev specifically because librdkafka's config
# source unconditionally includes curl/curl.h even with the WITH_CURL cmake
# flag off (the exact same real, previously-hit build failure documented in
# rtmp/Dockerfile for its own rdkafka producer).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 python3-pip pkg-config ca-certificates \
        cmake libssl-dev zlib1g-dev libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*
# Debian bookworm's pip refuses global installs by default (PEP 668); the
# mediasoup build script installs its own meson/ninja into a private
# directory, but this covers it if that guard still trips.
ENV PIP_BREAK_SYSTEM_PACKAGES=1
# mediasoup-sys's build script generates Rust code from flatbuffers schemas
# and pipes it through rustfmt to format it - not part of this image's
# default rustup profile, so the build fails with a broken-pipe error
# without it.
RUN rustup component add rustfmt
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
# ffmpeg: consumes the loopback RTP mediasoup sends during call recording and
# muxes it to a file (see src/sfu/recording.rs) - not needed for anything else.
# libssl3/zlib1g/libcurl4: the dynamically-linked runtime counterparts of the
# builder stage's rdkafka dev headers above - librdkafka itself is statically
# linked into the binary, these are its own further runtime dependencies
# (same pairing as rtmp/Dockerfile's identical rdkafka runtime deps).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget ffmpeg libssl3 zlib1g libcurl4 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/ws-sfu ./ws-sfu
EXPOSE 4000
EXPOSE 40000-40019/udp
EXPOSE 40000-40019/tcp
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["./ws-sfu"]
