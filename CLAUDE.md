# controltower

A 3D flight tracker with two apps:

- `apps/web`: the frontend, built with Vite, React 19, TypeScript, mapbox-gl 3, and three.js.
- `apps/api`: a Cargo workspace with two binaries. `ingest` polls adsb.lol and stores aircraft positions in PostGIS. `controltower-server` (in `server/`) is an axum web server that serves flight data to the frontend.

## Commands

Run these from `apps/web`:

- `npm run dev`: dev server
- `npx tsc -b && npx eslint src`: typecheck and lint. Run before committing.
- `npm run build`: production build

Run these from `apps/api`:

- `docker compose up -d`: start PostGIS on port 5433
- `cargo run -p ingest`: run migrations, then poll every 10 seconds
- `cargo run --release -p ingest -- import <dir>`: run migrations, then load the positions in a day of adsb.lol globe history from `<dir>` that are within `RADIUS_NM` of the center
- `cargo run -p controltower-server`: serve on `127.0.0.1:3000`
- `cargo clippy --workspace`: lint. Run before committing.

`apps/web` has no tests yet. Run `cargo test --workspace` from `apps/api`.

## Setup

`apps/web/.env` holds `VITE_MAPBOX_ACCESS_TOKEN` and `API_URL` and `apps/api/.env` holds `DATABASE_URL` (see each `.env.example`). Never commit them. `API_URL` is the API that `npm run dev` and `npm run preview` proxy `/api` to (default `http://127.0.0.1:3000`). The API sends no CORS headers, so the frontend only reaches it through that proxy.

## Architecture

### web

- `src/App.tsx` creates the map, adds an `AircraftLayer` and starts an `AircraftFeed`. A requestAnimationFrame loop has the feed draw onto the layer.
- `src/flight/AircraftFeed.ts` polls `GET /aircraft` (`src/flight/aircraftApi.ts`) for the visible area every 5 s and keeps each aircraft's trace. It draws aircraft as of the server's `now` minus 40 s, so that most have a newer recorded position to interpolate toward, and with `REPLAY_DATE` set it shows that day at the current time of day. Each aircraft's trace is smoothed and converted to scene coordinates once per poll; each frame only slices it to the last 60 s and fades it by age, so trail length shows speed. Aircraft beyond `maxAircraft` are skipped. Polling pauses while the page is hidden and polls right away when it is shown again.
- `src/flight/flightTrace.ts` converts traces and interpolates them: `positionAt` lerps between recorded positions and dead-reckons past the newest one for up to 30 s. `smoothPath` draws them as a cubic B-spline with the recorded positions as control points, to smooth out ADS-B jitter. The curve starts and ends exactly at the oldest and newest positions but doesn't pass through the others. `clampToGround` keeps aircraft at least 10 ft above the terrain and puts aircraft on the ground at exactly 10 ft. It skips positions above 8,849 m. The feed reapplies it to each aircraft about once a second, spread across frames, since terrain tiles load after the positions do.
- `src/flight/AircraftLayer.ts` is a Mapbox `CustomLayerInterface` that renders a three.js scene into Mapbox's GL context. Aircraft are added and moved by id with `setAircraft`, up to `maxAircraft`, and each call replaces the aircraft's trail with points from `scenePoint` that end at the aircraft. All planes, all trails and all drop lines are each one instanced draw call:
  - The scene frame is local meters around the layer's origin: x east, y north, z up. `sceneToMercator` maps it into Mercator, and Mapbox's matrix is premultiplied into the camera's projection matrix.
  - Positions go through `MercatorCoordinate`, so they are exact at any latitude. Scene units are meters only at the origin's latitude; each aircraft's `metersToScene` corrects its size.
  - The plane (`src/flight/planeModel.ts`) is an A320-200 at true scale, merged into one geometry with vertex colors. It is scaled up so it is never drawn shorter than `MIN_PLANE_LENGTH_PIXELS`.
  - A faint vertical line runs from the plane down to z=0.
- `src/flight/FadingTrails.ts` and `fadingTrail.{vert,frag}.glsl` draw instanced screen-space ribbons with a fade per point. Each trail has a fixed slot of segments; unused segments have zero fade and are skipped in the vertex shader. The shaders are imported with `?raw`.

### api

The crates share no code. Postgres is the only interface between them, and `ingest` owns the schema.

- `ingest/src/adsb.rs` calls `/v2/point/{lat}/{lon}/{radius}`. The center (SEA) and the 50 nm radius are constants in `ingest/src/main.rs`. Each aircraft is parsed separately, so a malformed record is skipped instead of failing the whole response.
- `ingest/src/store.rs` inserts every aircraft that has a position into `aircraft_positions` in one `UNNEST` query. `observed_at` is the response's `now` minus `seen_pos`. When a position hasn't changed since the last poll, it has the same `(hex, observed_at)` and the unique index drops the duplicate.
- `ingest import` loads the `traces/` of an adsb.lol daily globe history release (https://github.com/adsblol/globe_history_2026). `ingest/src/globe_history.rs` parses readsb's `trace_full_*.json` files, and `ingest/src/import.rs` inserts the positions within `RADIUS_NM` of the poller's center in batches.
- Positions are kept for `RETENTION` (1 day). A second loop in `ingest/src/main.rs` deletes older rows every minute.
- Migrations are in `migrations/` at the workspace root. `ingest` embeds them with `sqlx::migrate!("../migrations")`. Queries are checked at runtime, so building doesn't need a database.
- Indexes: GiST on `position`, btree on `(hex, observed_at)` and `(flight, observed_at)`, and BRIN on `observed_at`.
- `server/src/aircraft.rs` serves `GET /aircraft?bbox=west,south,east,north&trace_seconds=N`. It returns each aircraft whose latest position in the last N seconds is inside `bbox`, with all of its positions from that window, oldest first. `west > east` crosses the antimeridian. `server/src/store.rs` runs the query and groups the rows by `hex`.
- When `REPLAY_DATE` (`YYYY-MM-DD`) is set, the server's clock (`server/src/clock.rs`) is the current UTC time of day on that date, so imported history plays back as if it were live.
- The server documents its routes with aide. Each route is added with `api_route` and a `*_docs` function, and response types derive `schemars::JsonSchema`. The spec is served at `/openapi.json` and a Scalar docs page at `/docs`.

## Gotchas

- `FadingTrails` uses `DoubleSide` because the ribbon's winding depends on the segment direction. Segments are clipped against the near plane in clip space (`z + w >= 0`). Don't use a fixed `w` epsilon: Mapbox's matrix scale makes it cull everything.
- `linewidth` values are in drawing-buffer pixels, not CSS pixels.
- Custom layers only render correctly in Mercator. The map style uses globe projection at low zoom.
- The style has 3D terrain, but altitudes are relative to sea level. At SEA the ground is about 80 m, so anything lower is hidden under terrain.
- At high zoom, the Mapbox camera can be lower than the plane, which puts the plane out of view.
- The newest stored position is usually 10 to 35 s old: adsb.lol lags, and the poll interval adds to that. A `trace_seconds` below about 30 can return nothing.
- adsb.lol returned frequent 429s at a 5 s interval, so ingest polls every 10 s. Its `now` runs about 10 s behind real time. Failed polls are logged and retried on the next tick.
- `cargo run -p ingest` (polling) prunes rows older than a day, so it deletes imported history. Don't run it while replaying.
- A day of globe history is about 96M positions worldwide and about 300 bytes per row in Postgres, which is why `ingest import` keeps only the SEA area. It still parses every file, so run it with `--release`.
- The console warnings about missing `airport`/`airfield` images come from the map style, not from this code.
