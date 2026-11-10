// Client for the controltower API's `GET /api/aircraft`, reached through the Vite proxy or Caddy.

import { METERS_PER_DEGREE, metersPerDegreeLng, wrapLongitude } from './geo';
import type { ServerClock } from './ServerClock';

export interface TracePoint {
  // Milliseconds since the Unix epoch.
  observed_at: number;
  lat: number;
  lon: number;
  on_ground: boolean;
  // Feet.
  alt_baro: number | null;
  alt_geom: number | null;
  // Knots.
  ground_speed: number | null;
  // Degrees clockwise from true north.
  track: number | null;
  true_heading: number | null;
}

export interface ApiAircraft {
  aircraft_address: string;
  flight: string | null;
  // Oldest first.
  trace: TracePoint[];
}

// [west, south, east, north] in degrees. `west > east` crosses the antimeridian.
export type BoundingBox = [number, number, number, number];

// Degrees of longitude `bbox` spans, in [0, 360].
function lngSpan([west, , east]: BoundingBox): number {
  return west <= east ? east - west : east - west + 360;
}

// `bbox` grown by `meters` on every side. Longitudes are padded by the most degrees `meters` spans
// within the box's latitudes.
export function padBoundingBox(bbox: BoundingBox, meters: number): BoundingBox {
  const [west, south, east, north] = bbox;
  const latPad = meters / METERS_PER_DEGREE;
  const padSouth = Math.max(south - latPad, -90);
  const padNorth = Math.min(north + latPad, 90);
  const maxAbsLat = Math.min(Math.max(Math.abs(padSouth), Math.abs(padNorth)), 89);
  const lngPad = meters / metersPerDegreeLng(maxAbsLat);
  if (lngSpan(bbox) + 2 * lngPad >= 360) {
    return [-180, padSouth, 180, padNorth];
  }
  return [wrapLongitude(west - lngPad), padSouth, wrapLongitude(east + lngPad), padNorth];
}

// Thrown by `fetchAircraft` when the server won't search an area as large as `bbox`.
export class AreaTooLargeError extends Error {}

// Fetches the positions observed in `[sinceSeconds, untilSeconds)` inside `bbox`, grouped by
// aircraft. Times are seconds since the Unix epoch. Every response, including errors, syncs `clock`.
export async function fetchAircraft(
  bbox: BoundingBox,
  sinceSeconds: number,
  untilSeconds: number,
  clock: ServerClock,
  signal?: AbortSignal,
): Promise<ApiAircraft[]> {
  const params = new URLSearchParams({
    bbox: bbox.join(','),
    since: String(sinceSeconds),
    until: String(untilSeconds),
  });
  const requestedMs = Date.now();
  const response = await fetch(`/api/aircraft?${params}`, { signal });
  clock.sync(response, requestedMs, Date.now());
  if (response.status === 413) {
    throw new AreaTooLargeError(await response.text());
  }
  if (!response.ok) {
    throw new Error(`GET /api/aircraft failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}
