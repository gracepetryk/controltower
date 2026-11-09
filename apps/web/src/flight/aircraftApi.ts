// Client for the controltower API's `GET /aircraft`, served under /api by the dev server's proxy.

import { METERS_PER_DEGREE, metersPerDegreeLng, wrapLongitude } from './geo';

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

export interface AircraftResponse {
  // The server's time in milliseconds since the Unix epoch. When it is replaying recorded
  // positions, this is the replayed time.
  now: number;
  aircraft: ApiAircraft[];
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

// Fetches the positions in the last `traceSeconds` inside `bbox`, grouped by aircraft.
export async function fetchAircraft(
  bbox: BoundingBox,
  traceSeconds: number,
  signal?: AbortSignal,
): Promise<AircraftResponse> {
  const params = new URLSearchParams({ bbox: bbox.join(','), trace_seconds: String(traceSeconds) });
  const response = await fetch(`/api/aircraft?${params}`, { signal });
  if (response.status === 413) {
    throw new AreaTooLargeError(await response.text());
  }
  if (!response.ok) {
    throw new Error(`GET /aircraft failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}
