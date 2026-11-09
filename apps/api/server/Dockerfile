# Build from apps/api: docker build -f server/Dockerfile -t controltower-server .
FROM rust:1.99-slim-trixie AS chef
RUN cargo install cargo-chef --locked --version 0.1.78
WORKDIR /src

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# Dependencies are built in their own layer, which is only rebuilt when the
# recipe (Cargo.toml and Cargo.lock) or the base image changes.
FROM chef AS build
COPY --from=planner /src/recipe.json recipe.json
RUN cargo chef cook --release --locked -p controltower-server --recipe-path recipe.json
COPY . .
RUN cargo build --release --locked -p controltower-server \
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
