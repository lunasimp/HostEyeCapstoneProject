FROM rust:1.88-bookworm AS builder

WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim

RUN useradd --system --create-home --home-dir /app hosteye \
    && mkdir -p /app/data \
    && chown -R hosteye /app
WORKDIR /app
COPY --from=builder /src/target/release/hosteye-config-server /usr/local/bin/hosteye-config-server
COPY --from=builder /src/target/release/hosteye-config-client /usr/local/bin/hosteye-config-client
USER hosteye

EXPOSE 5063
CMD ["hosteye-config-server"]


