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

- `src/App.tsx` creates the map and adds a `PlaneLayer`. A requestAnimationFrame loop feeds it positions from `src/flight/simulatedFlight.ts`. Positions are simulated; real flight data is not wired in yet.
- `src/flight/PlaneLayer.ts` is a Mapbox `CustomLayerInterface` that renders a three.js scene into Mapbox's GL context:
  - The scene frame is local meters around the layer's origin: x east, y north, z up. `sceneToMercator` maps it into Mercator, and Mapbox's matrix is premultiplied into the camera's projection matrix.
  - The plane is an A300-600 at true scale. It is scaled up so it is never drawn shorter than `MIN_PLANE_LENGTH_PIXELS`.
  - A faint vertical line runs from the plane down to z=0.
- `src/flight/FadingTrail.ts` and `fadingTrail.{vert,frag}.glsl` draw an instanced screen-space ribbon that fades toward its oldest point. The shaders are imported with `?raw`.

## Gotchas

- `FadingTrail` uses `DoubleSide` because the ribbon's winding depends on the segment direction. Segments are clipped against the near plane in clip space (`z + w >= 0`). Don't use a fixed `w` epsilon: Mapbox's matrix scale makes it cull everything.
- `linewidth` values are in drawing-buffer pixels, not CSS pixels.
- Custom layers only render correctly in Mercator. The map style uses globe projection at low zoom.
- The style has 3D terrain, but altitudes are relative to sea level. At SEA the ground is about 80 m, so anything lower is hidden under terrain.
- At high zoom, the Mapbox camera can be lower than the plane, which puts the plane out of view.
- The console warnings about missing `airport`/`airfield` images come from the map style, not from this code.
