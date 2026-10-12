# Build from apps/api: docker build -f server/Dockerfile -t controltower-server .
FROM rust:1.99-slim-trixie AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p controltower-server \
    && cp target/release/controltower-server /usr/local/bin/

FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/controltower-server /usr/local/bin/
USER nobody
ENV BIND_ADDR=0.0.0.0:3000
EXPOSE 3000
# The server shuts down gracefully on SIGINT, not SIGTERM.
STOPSIGNAL SIGINT
ENTRYPOINT ["controltower-server"]
