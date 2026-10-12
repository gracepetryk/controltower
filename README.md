# controltower

A 3D flight tracker for the Seattle area. It records ADS-B positions from [adsb.lol](https://adsb.lol) and draws each aircraft as a true-scale model on a Mapbox map, with a fading trail of its last 60 seconds and a line down to the ground.

![Arrivals on final approach into SEA](docs/screenshots/sea-arrivals.jpg)

![Aircraft taxiing at SEA](docs/screenshots/sea-ground.jpg)

![Traffic over Puget Sound, with the arrival stream into SEA](docs/screenshots/puget-sound.jpg)

## How it works

- `apps/api/ingest` polls adsb.lol every 10 seconds for aircraft within 50 nm of SEA and stores their positions in PostGIS. It can also import a day of [adsb.lol globe history](https://github.com/adsblol/globe_history_2026) for replay.
- `apps/api/server` is an axum server. Its routes are under `/api`: `GET /api/aircraft` returns the aircraft in a bounding box with their recent positions, and API docs are served at `/api/docs`.
- `apps/web` is a Vite + React app. It renders aircraft with three.js in a Mapbox custom layer, interpolates between recorded positions and smooths the trails.

## Running it

You need Docker, Rust, Node and a [Mapbox access token](https://account.mapbox.com/access-tokens/).

```sh
# API
docker compose up -d db          # PostGIS on port 5433, from the repo root
cd apps/api
cp .env.example .env
cargo run -p ingest              # start recording positions
cargo run -p controltower-server # serve on 127.0.0.1:3000

# Web
cd apps/web
cp .env.example .env        # set VITE_MAPBOX_ACCESS_TOKEN
npm install
npm run dev
```

The dev server proxies `/api` to `API_URL` (default `http://127.0.0.1:3000`).

To replay a past day instead of live traffic, import it and set `REPLAY_DATE` for the server:

```sh
cargo run --release -p ingest -- import <globe_history_dir>
REPLAY_DATE=2026-10-10 cargo run -p controltower-server
```

Don't run the poller while replaying: it deletes positions older than a day.

To run the frontend and server in Docker behind Caddy, from the repo root:

```sh
cp .env.example .env        # set VITE_MAPBOX_ACCESS_TOKEN
docker compose up -d --build
```

Caddy serves the frontend on `/` and the API on `/api` over plain HTTP at `127.0.0.1:8080` (`CADDY_PORT`). It's meant to sit behind a Cloudflare tunnel, which terminates TLS.

The server in `compose.yaml` replays 2026-10-10, so import that day first as above, and don't run the poller. To show live traffic instead, remove `REPLAY_DATE` from `compose.yaml` and run the poller on the host:

```sh
docker compose up -d server
cd apps/api
cp .env.example .env
cargo run -p ingest
```
