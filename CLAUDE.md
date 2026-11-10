# controltower

A 3D flight tracker with two apps:

- `apps/web`: the frontend, built with Vite, React 19, TypeScript, mapbox-gl 3, and three.js.
- `apps/api`: a Cargo workspace with two binaries. `ingest` polls adsb.lol and stores aircraft positions in PostGIS. `controltower-server` (in `server/`) is an axum web server that serves flight data to the frontend.

## Commands

Run these from the repo root:

- `docker compose up -d db`: start PostGIS on port 5433, so it doesn't conflict with a Postgres on the host's 5432
- `docker compose up -d --build`: run PostGIS, the server, Caddy, which serves the frontend on `/` and the API on `/api`, and cloudflared

Run these from `apps/web`:

- `npm run dev`: dev server
- `npx tsc -b && npx eslint src`: typecheck and lint. Run before committing.
- `npm run build`: production build

Run these from `apps/api`:

- `cargo run -p ingest`: run migrations, then poll every 10 seconds
- `cargo run --release -p ingest -- import <dir>`: run migrations, then load the positions in a day of adsb.lol globe history from `<dir>` that are within `RADIUS_NM` of the center
- `cargo run -p controltower-server`: serve on `127.0.0.1:3000`, or `BIND_ADDR` if set
- `cargo clippy --workspace`: lint. Run before committing.

`apps/web` has no tests yet. Run `cargo test --workspace` from `apps/api`.

## Setup

`apps/web/.env` holds `VITE_MAPBOX_ACCESS_TOKEN` and `API_URL`, `apps/api/.env` holds `DATABASE_URL`, and the root `.env` holds the compose settings `VITE_MAPBOX_ACCESS_TOKEN` and `TUNNEL_TOKEN` (see each `.env.example`). Every compose command needs `VITE_MAPBOX_ACCESS_TOKEN` and `TUNNEL_TOKEN` set, even `docker compose up -d db`. Never commit them. `API_URL` is the API that `npm run dev` and `npm run preview` proxy `/api` to (default `http://127.0.0.1:3000`). The API sends no CORS headers, so the frontend only reaches it through that proxy, or through Caddy in compose.

## Architecture

### web

- `src/App.tsx` creates the map with navigation, fullscreen, scale and GitHub link (`src/GitHubControl.ts`) controls, an `AircraftFeed` and an `AircraftLayer` that reads from it, and sets the polling hook's area to the visible area when the map loads and on every `moveend`. While the camera moves, it pauses polling and `MapTerrain`, since rebuilding aircraft mid-move would stutter the animation. `DISPLAY_DELAY_MS` and `TRAIL_MS` are set here.
- `src/flight/useAircraftPolling.ts` polls `GET /api/aircraft` (`src/flight/aircraftApi.ts`) into the feed every 5 s. Each poll fetches positions up to now. The first poll for an area fetches the feed's whole history and replaces its aircraft; later polls fetch from `POSITION_SETTLE_MS` (40 s) before where the previous one ended, to pick up positions stored after they were observed, and add to the feed. Times are UTC seconds from the local clock. It returns `setBounds` and `setPaused`, like `useState`. The area is padded by how far a fast jet flies in the feed's history so that trails run off the edge of the view. The visible area is cut off at `MAX_VIEW_DISTANCE_M` (120 km) from the map center so a tilted camera doesn't request up to the horizon. Each new area cancels the request in flight and polls right away. After a 413 it clears the feed and stops polling until the area changes. Polling pauses while the page is hidden or after `setPaused(true)`, and polls right away when it resumes.
- `src/flight/AircraftFeed.ts` holds each aircraft's trace, with altitudes clamped to the ground from its `Ground` dependency. While it holds aircraft, it listens to the `Ground`, and when it reports a change, clamps every position again with `withGroundClamping` and replaces the traces whose altitudes changed by 0.5 m or more. `addAircraft` appends each aircraft's positions newer than its newest, keeping at most `MAX_POSITIONS` (128, enough for `historyMs` of positions a second apart), and drops aircraft with no position in the last `historyMs`. Traces that didn't change keep their array, so `AircraftLayer` keeps their tracks. Listeners added with `subscribe` are called when the aircraft change.
- `src/flight/MapTerrain.ts` is the `Ground` from the Mapbox map's terrain. `App` attaches the map to it. Altitudes are clamped to the terrain as drawn, and Mapbox loads that terrain in tiles and refines it as you zoom in, so the ground under a position changes over time. Terrain that hasn't loaded reads as 0. It reports a change once the terrain source's tiles stop loading for 250 ms, and holds changes between `pause` and `resume`.
- `src/flight/AircraftTrack.ts` prepares one aircraft's trace for drawing. It interpolates it with `positionAt`, and smooths it from where its trail starts and converts it to scene coordinates once; `trailAt` only slices that path to the last 60 s and fades it by age, so trail length shows speed.
- `src/flight/flightTrace.ts` converts traces and interpolates them: `positionAt` lerps between recorded positions and dead-reckons past the newest one for up to 30 s. `smoothPath` draws them as a cubic B-spline with the recorded positions as control points, to smooth out ADS-B jitter. The curve starts and ends exactly at the oldest and newest positions but doesn't pass through the others. `toTimedPositions` keeps aircraft at least 10 ft above the ground elevation it is given and puts aircraft on the ground at exactly 10 ft. It doesn't look up the ground for positions above 8,849 m.
- `src/flight/AircraftLayer.ts` is a Mapbox `CustomLayerInterface` that renders a three.js scene into Mapbox's GL context. Each render it keeps an `AircraftTrack` per aircraft in its feed, replaced when the aircraft's trace changes, and draws each one as of `DISPLAY_DELAY_MS` (60 s) ago, so that the positions fetched since then lead it until the next poll. Aircraft beyond `maxAircraft` are skipped. It keeps Mapbox repainting while it has tracks, and repaints when the feed's aircraft are replaced. Errors while drawing aircraft are caught and logged once, so they don't stop Mapbox drawing the rest of the map. All planes, all trails and all drop lines are each one instanced draw call:
  - The scene frame is local meters around the layer's origin: x east, y north, z up. `sceneToMercator` maps it into Mercator, and Mapbox's matrix is premultiplied into the camera's projection matrix.
  - Positions go through `MercatorCoordinate`, so they are exact at any latitude. Scene units are meters only at the origin's latitude; each aircraft's `metersToScene` corrects its size.
  - The plane (`src/flight/planeModel.ts`) is an A320-200 at true scale, merged into one geometry with vertex colors. It is scaled up so it is never drawn shorter than `MIN_PLANE_LENGTH_PIXELS`.
  - A faint vertical line runs from the plane down to z=0.
- `src/flight/FadingTrails.ts` and `fadingTrail.{vert,frag}.glsl` draw instanced screen-space ribbons with a fade per point. Each trail has a fixed slot of segments; unused segments have zero fade and are skipped in the vertex shader. The shaders are imported with `?raw`.

### api

The crates share no code. Postgres is the only interface between them, and `ingest` owns the schema.

- `ingest/src/adsb.rs` calls `/v2/point/{lat}/{lon}/{radius}`. The center (SEA) and the 50 nm radius are constants in `ingest/src/main.rs`. Each aircraft is parsed separately, so a malformed record is skipped instead of failing the whole response.
- `ingest/src/store.rs` inserts every aircraft that has a position into `aircraft_positions` in one `UNNEST` query. `observed_at` is the response's `now` minus `seen_pos`. When a position hasn't changed since the last poll, it has the same `(aircraft_address, observed_at)` and the unique index drops the duplicate.
- `ingest import` loads the `traces/` of an adsb.lol daily globe history release (https://github.com/adsblol/globe_history_2026). `ingest/src/globe_history.rs` parses readsb's `trace_full_*.json` files, and `ingest/src/import.rs` inserts the positions within `RADIUS_NM` of the poller's center in batches.
- Positions are kept for `RETENTION` (1 day). A second loop in `ingest/src/main.rs` deletes older rows every minute.
- Migrations are in `migrations/` at the workspace root. `ingest` embeds them with `sqlx::migrate!("../migrations")`. `server` checks its queries at compile time with `sqlx::query_as!`, so building it needs `DATABASE_URL` pointing at a migrated database, or `SQLX_OFFLINE=true` with the query data in `.sqlx/` from `cargo sqlx prepare --workspace`. The server's Dockerfile builds with `SQLX_OFFLINE=true`, so rerun `cargo sqlx prepare --workspace` after changing a query.
- Indexes: GiST on `position`, btree on `(aircraft_address, observed_at)` and `(flight, observed_at)`, and BRIN on `observed_at`.
- `server/src/aircraft.rs` serves `GET /api/aircraft?bbox=west,south,east,north&since=S&until=S`. It returns the positions observed in `[since, until)` (UTC seconds, at most 5 minutes apart, since the API is public) inside `bbox`, grouped by aircraft, oldest first. `west > east` crosses the antimeridian, and `bbox` can be at most `MAX_AREA_EDGE_METERS` (400 km) along each edge, measuring the south and north edges along their parallels, or the server returns 413. `server/src/store.rs` runs the query and groups the rows by `aircraft_address`.
- When `REPLAY_DATE` (`YYYY-MM-DD`) is set, `server/src/clock.rs` moves each requested span to the same times of day on that date, and the server reports `observed_at` as if it were today, so imported history plays back as if it were live.
- The server documents its routes with aide. Each route is added with `api_route` and a `*_docs` function, and response types derive `schemars::JsonSchema`. All routes are nested under `/api`. The spec is served at `/api/openapi.json` and a Scalar docs page at `/api/docs`.

### Deployment

- `compose.yaml` at the repo root runs `db`, `server` (`apps/api/server/Dockerfile`), `web`, `caddy` and `cloudflared`. They share the `internal` network, which has no route out and, with `inhibit_ipv4`, no host address, so its containers can't reach the host's services either. Only `cloudflared` is also on `internet`. `db` is also on `db-host`, because Docker only publishes ports from containers on a non-internal network, and `ingest` reaches it from the host on 5433. It sets the server's `REPLAY_DATE` to 2026-10-10. The `web` image (`apps/web/Dockerfile`) builds the frontend, with `VITE_MAPBOX_ACCESS_TOKEN` as a build arg. The `web` service has no network; it replaces the contents of the `web` volume with the build and exits. `caddy` runs the stock `caddy:2-alpine` image once `web` has finished, with the `web` volume mounted read-only on `/srv` and the root `Caddyfile` mounted into it, so upgrading Caddy doesn't rebuild the frontend. `ingest` isn't containerized.
- Caddy listens on plain HTTP on `:8080` and isn't published on the host, so the tunnel is the only way in. TLS is terminated by the Cloudflare tunnel that `cloudflared` runs with `TUNNEL_TOKEN`. The tunnel is configured in the Cloudflare dashboard, with its public hostname pointing at `http://caddy:8080`. `/api` and `/api/*` are proxied to the server unchanged, the same as the Vite proxy. Everything else is the frontend, with `/assets/*` cached as immutable.

## Gotchas

- `FadingTrails` uses `DoubleSide` because the ribbon's winding depends on the segment direction. Segments are clipped against the near plane in clip space (`z + w >= 0`). Don't use a fixed `w` epsilon: Mapbox's matrix scale makes it cull everything.
- `linewidth` values are in drawing-buffer pixels, not CSS pixels.
- Custom layers only render correctly in Mercator. The map style uses globe projection at low zoom.
- The style has 3D terrain, but altitudes are relative to sea level. At SEA the ground is about 80 m, so anything lower is hidden under terrain.
- At high zoom, the Mapbox camera can be lower than the plane, which puts the plane out of view.
- The newest stored position is usually 10 to 35 s old: adsb.lol lags, and the poll interval adds to that. That is why each poll re-fetches the 40 s before the previous one ended.
- adsb.lol returned frequent 429s at a 5 s interval, so ingest polls every 10 s. Its `now` runs about 10 s behind real time. Failed polls are logged and retried on the next tick.
- `cargo run -p ingest` (polling) prunes rows older than a day, so it deletes imported history. Don't run it while replaying.
- A day of globe history is about 96M positions worldwide and about 300 bytes per row in Postgres, which is why `ingest import` keeps only the SEA area. It still parses every file, so run it with `--release`.
- The console warnings about missing `airport`/`airfield` images come from the map style, not from this code.
