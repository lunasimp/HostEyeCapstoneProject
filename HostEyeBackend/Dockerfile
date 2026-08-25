# HostEye Backend — Multi-stage Rust build
# Stage 1 build tất cả 3 binaries, các stage tiếp theo chỉ copy binary cần thiết.
# Usage trong docker-compose:
#   build:
#     context: ../HostEyeBackend
#     target: data_server   # hoặc control_server / worker_server

# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM rust:1.97-slim AS builder

# Cài dependencies hệ thống cần thiết để build
# libssl-dev + pkg-config: cho clickhouse crate (rustls-tls vẫn cần pkg-config)
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Cache dependencies trước khi copy source (layer cache optimization)
# Tạo dummy src để cargo có thể build deps mà không cần source thực
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src/servers src/data_plane src/storage src/worker src/control_plane src/shared && \
    echo '#[tokio::main] async fn main() {}' > src/servers/data_server.rs && \
    echo '#[tokio::main] async fn main() {}' > src/servers/control_server.rs && \
    echo '#[tokio::main] async fn main() {}' > src/servers/worker_server.rs && \
    cargo build --release 2>/dev/null || true

# Copy source thực
COPY src ./src

# Build tất cả 3 binaries
# Dùng touch để force rebuild vì timestamps có thể không thay đổi
RUN touch src/servers/data_server.rs src/servers/control_server.rs src/servers/worker_server.rs && \
    cargo build --release \
        --bin data_server \
        --bin control_server \
        --bin worker_server

# ─── Stage 2: data_server ─────────────────────────────────────────────────────
FROM debian:trixie-slim AS data_server

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/target/release/data_server ./data_server

# Thư mục raw chunks (mount từ docker-compose volume)
RUN mkdir -p /var/lib/hosteye/raw_chunks

# Default env (override từ docker-compose)
ENV PORT=8088 \
    COLLECTOR_ID=collector-unknown \
    CLICKHOUSE_URL=http://clickhouse:8123 \
    VECTOR_URL=http://vector-gateway-1:8686/ \
    RAW_CHUNK_DIR=/var/lib/hosteye/raw_chunks \
    DIRECT_VECTOR_FORWARD=false \
    REQUIRED_SCHEMA_VERSION=1.0.0 \
    RAW_CHUNK_TOPIC=raw-chunk-jobs \
    COLLECTOR_UPLOAD_SLOT_MS=1000 \
    ADMISSION_MAX_ACTIVE_UPLOADS=64

EXPOSE 8088
CMD ["./data_server"]

# ─── Stage 3: control_server ──────────────────────────────────────────────────
FROM debian:trixie-slim AS control_server

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/target/release/control_server ./control_server

ENV PORT=8080 \
    CLICKHOUSE_URL=http://clickhouse:8123 \
    PUBLIC_BASE_URL=https://hosteye.iahn.hanoi.vn

EXPOSE 8080
CMD ["./control_server"]

# ─── Stage 4: worker_server ───────────────────────────────────────────────────
FROM debian:trixie-slim AS worker_server

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/target/release/worker_server ./worker_server

# raw_chunks phải được mount từ cùng volume với data_server
RUN mkdir -p /var/lib/hosteye/raw_chunks

ENV REDPANDA_PROXY_URL=http://redpanda-broker:8082 \
    RAW_CHUNK_TOPIC=raw-chunk-jobs \
    RAW_WORKER_GROUP=raw-chunk-worker \
    CLICKHOUSE_URL=http://clickhouse:8123 \
    VECTOR_URL=http://vector-gateway-1:8686/

CMD ["./worker_server"]
