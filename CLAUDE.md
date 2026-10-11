# controltower

A 3D flight tracker with two apps:

- `apps/web`: the frontend, built with Vite, React 19, TypeScript, mapbox-gl 3, and three.js.
- `apps/api`: a Cargo workspace with two binaries. `ingest` polls adsb.lol and stores aircraft positions in PostGIS. `server` is an axum web server that serves flight data to the frontend.

## Commands

Run these from `apps/web`:

- `npm run dev`: dev server
- `npx tsc -b && npx eslint src`: typecheck and lint. Run before committing.
- `npm run build`: production build

Run these from `apps/api`:

- `docker compose up -d`: start PostGIS on port 5433
- `cargo run -p ingest`: run migrations, then poll every 5 seconds
- `cargo run -p server`: serve on `127.0.0.1:3000`
- `cargo clippy --workspace`: lint. Run before committing.

`apps/web` has no tests yet. Run `cargo test --workspace` from `apps/api`.

## Setup

`apps/web/.env` holds `VITE_MAPBOX_ACCESS_TOKEN` and `apps/api/.env` holds `DATABASE_URL` (see each `.env.example`). Never commit them.

## Architecture

### web

- `src/App.tsx` creates the map and adds an `AircraftLayer`. A requestAnimationFrame loop feeds it positions from `src/flight/simulatedFlight.ts`. Positions are simulated; real flight data is not wired in yet.
- `src/flight/AircraftLayer.ts` is a Mapbox `CustomLayerInterface` that renders a three.js scene into Mapbox's GL context. Aircraft are added and moved by id with `setAircraft`, up to `maxAircraft`. All planes, all trails and all drop lines are each one instanced draw call:
  - The scene frame is local meters around the layer's origin: x east, y north, z up. `sceneToMercator` maps it into Mercator, and Mapbox's matrix is premultiplied into the camera's projection matrix.
  - Positions go through `MercatorCoordinate`, so they are exact at any latitude. Scene units are meters only at the origin's latitude; each aircraft's `metersToScene` corrects its size and trail spacing.
  - The plane (`src/flight/planeModel.ts`) is an A320-200 at true scale, merged into one geometry with vertex colors. It is scaled up so it is never drawn shorter than `MIN_PLANE_LENGTH_PIXELS`.
  - A faint vertical line runs from the plane down to z=0.
- `src/flight/FadingTrails.ts` and `fadingTrail.{vert,frag}.glsl` draw instanced screen-space ribbons that fade toward their oldest point. Each trail has a fixed slot of segments; unused segments have zero fade and are skipped in the vertex shader. The shaders are imported with `?raw`.

### api

The crates share no code. Postgres is the only interface between them, and `ingest` owns the schema.

- `ingest/src/adsb.rs` calls `/v2/point/{lat}/{lon}/{radius}`. The center (SEA) and the 150 nm radius are constants in `ingest/src/main.rs`. Each aircraft is parsed separately, so a malformed record is skipped instead of failing the whole response.
- `ingest/src/store.rs` inserts every aircraft that has a position into `aircraft_positions` in one `UNNEST` query. `observed_at` is the response's `now` minus `seen_pos`. When a position hasn't changed since the last poll, it has the same `(hex, observed_at)` and the unique index drops the duplicate.
- Positions are kept for `RETENTION` (1 day). A second loop in `ingest/src/main.rs` deletes older rows every minute.
- Migrations are in `migrations/` at the workspace root. `ingest` embeds them with `sqlx::migrate!("../migrations")`. Queries are checked at runtime, so building doesn't need a database.
- Indexes: GiST on `position`, btree on `(hex, observed_at)` and `(flight, observed_at)`, and BRIN on `observed_at`.
- `server/src/aircraft.rs` serves `GET /aircraft?bbox=west,south,east,north&trace_seconds=N`. It returns each aircraft whose latest position in the last N seconds is inside `bbox`, with all of its positions from that window, oldest first. `west > east` crosses the antimeridian. `server/src/store.rs` runs the query and groups the rows by `hex`.

## Gotchas

- `FadingTrails` uses `DoubleSide` because the ribbon's winding depends on the segment direction. Segments are clipped against the near plane in clip space (`z + w >= 0`). Don't use a fixed `w` epsilon: Mapbox's matrix scale makes it cull everything.
- `linewidth` values are in drawing-buffer pixels, not CSS pixels.
- Custom layers only render correctly in Mercator. The map style uses globe projection at low zoom.
- The style has 3D terrain, but altitudes are relative to sea level. At SEA the ground is about 80 m, so anything lower is hidden under terrain.
- At high zoom, the Mapbox camera can be lower than the plane, which puts the plane out of view.
- The newest stored position is usually 10 to 30 s old: adsb.lol lags, and the poll interval adds to that. A `trace_seconds` below about 30 can return nothing.
- adsb.lol sometimes returns 429 at a 5 s interval, and its `now` runs about 10 s behind real time. Failed polls are logged and retried on the next tick.
- The console warnings about missing `airport`/`airfield` images come from the map style, not from this code.
