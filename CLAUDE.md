# controltower

A 3D flight tracker. The only app so far is `apps/web`, built with Vite, React 19, TypeScript, mapbox-gl 3, and three.js.

## Commands

Run these from `apps/web`:

- `npm run dev`: dev server
- `npx tsc -b && npx eslint src`: typecheck and lint. Run before committing.
- `npm run build`: production build

There are no tests yet.

## Setup

`apps/web/.env` holds `VITE_MAPBOX_ACCESS_TOKEN` (see `.env.example`). Never commit it.

## Architecture

- `src/App.tsx` creates the map and adds an `AircraftLayer`. A requestAnimationFrame loop feeds it positions from `src/flight/simulatedFlight.ts`. Positions are simulated; real flight data is not wired in yet.
- `src/flight/AircraftLayer.ts` is a Mapbox `CustomLayerInterface` that renders a three.js scene into Mapbox's GL context. Aircraft are added and moved by id with `setAircraft`, up to `maxAircraft`. All planes, all trails and all drop lines are each one instanced draw call:
  - The scene frame is local meters around the layer's origin: x east, y north, z up. `sceneToMercator` maps it into Mercator, and Mapbox's matrix is premultiplied into the camera's projection matrix.
  - Positions go through `MercatorCoordinate`, so they are exact at any latitude. Scene units are meters only at the origin's latitude; each aircraft's `metersToScene` corrects its size and trail spacing.
  - The plane (`src/flight/planeModel.ts`) is an A320-200 at true scale, merged into one geometry with vertex colors. It is scaled up so it is never drawn shorter than `MIN_PLANE_LENGTH_PIXELS`.
  - A faint vertical line runs from the plane down to z=0.
- `src/flight/FadingTrails.ts` and `fadingTrail.{vert,frag}.glsl` draw instanced screen-space ribbons that fade toward their oldest point. Each trail has a fixed slot of segments; unused segments have zero fade and are skipped in the vertex shader. The shaders are imported with `?raw`.

## Gotchas

- `FadingTrails` uses `DoubleSide` because the ribbon's winding depends on the segment direction. Segments are clipped against the near plane in clip space (`z + w >= 0`). Don't use a fixed `w` epsilon: Mapbox's matrix scale makes it cull everything.
- `linewidth` values are in drawing-buffer pixels, not CSS pixels.
- Custom layers only render correctly in Mercator. The map style uses globe projection at low zoom.
- The style has 3D terrain, but altitudes are relative to sea level. At SEA the ground is about 80 m, so anything lower is hidden under terrain.
- At high zoom, the Mapbox camera can be lower than the plane, which puts the plane out of view.
- The console warnings about missing `airport`/`airfield` images come from the map style, not from this code.
