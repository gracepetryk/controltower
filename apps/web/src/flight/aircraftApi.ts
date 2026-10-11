// Client for the controltower API's `GET /aircraft`, served under /api by the dev server's proxy.

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
  hex: string;
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

// Fetches the aircraft whose latest position in the last `traceSeconds` is inside `bbox`, each with
// its positions from that window.
export async function fetchAircraft(
  bbox: BoundingBox,
  traceSeconds: number,
  signal?: AbortSignal,
): Promise<AircraftResponse> {
  const params = new URLSearchParams({ bbox: bbox.join(','), trace_seconds: String(traceSeconds) });
  const response = await fetch(`/api/aircraft?${params}`, { signal });
  if (!response.ok) {
    throw new Error(`GET /aircraft failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}
