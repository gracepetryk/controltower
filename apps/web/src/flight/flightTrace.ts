import type { TracePoint } from './aircraftApi';
import { METERS_PER_DEGREE, metersPerDegreeLng } from './geo';
import type { FlightPosition } from './types';

const FEET_TO_METERS = 0.3048;
const KNOTS_TO_METERS_PER_SECOND = 1852 / 3600;
// Altitudes are clamped to at least this far above the ground, so aircraft sit on top of the terrain.
const GROUND_CLEARANCE_METERS = 10 * FEET_TO_METERS;
// No terrain is higher than this (Everest), so positions above it are never clamped.
const MAX_TERRAIN_ELEVATION_METERS = 8_849;
// Clamping to refined terrain only counts as a change past this, so that small refinements don't
// rebuild every aircraft's trail.
const CLAMP_TOLERANCE_METERS = 0.5;
// Past its newest position, an aircraft keeps moving along its track for at most this long, then holds.
const MAX_EXTRAPOLATION_MS = 30_000;

export interface TimedPosition extends FlightPosition {
  // Milliseconds since the Unix epoch.
  timeMs: number;
  // Direction of motion in degrees clockwise from true north.
  trackDegrees: number;
  groundSpeedMetersPerSecond: number;
  // Reported altitude in meters, or null on the ground. `altitudeMeters` is this, clamped to at
  // least GROUND_CLEARANCE_METERS above the ground.
  reportedAltitudeMeters: number | null;
}

// A point on a smoothed path, and the time the aircraft passed it.
export interface PathPoint {
  lng: number;
  lat: number;
  altitudeMeters: number;
  // Milliseconds since the Unix epoch.
  timeMs: number;
}

// Converts an API trace, oldest first, into positions. Missing headings, tracks, ground speeds and
// altitudes carry over from the previous point. Each altitude is clamped to at least
// GROUND_CLEARANCE_METERS above `groundElevation`, and positions on the ground are clamped to exactly
// that clearance. Positions reported above any terrain aren't clamped.
export function toTimedPositions(
  trace: TracePoint[],
  groundElevation: (lng: number, lat: number) => number,
): TimedPosition[] {
  const positions: TimedPosition[] = [];
  for (const point of trace) {
    const previous = positions.at(-1);
    const altitudeFeet = point.alt_geom ?? point.alt_baro;
    const headingDegrees = point.true_heading ?? point.track ?? previous?.headingDegrees ?? 0;
    const reportedAltitudeMeters = point.on_ground
      ? null
      : altitudeFeet !== null
        ? altitudeFeet * FEET_TO_METERS
        : (previous?.reportedAltitudeMeters ?? 0);
    positions.push({
      timeMs: point.observed_at,
      lng: point.lon,
      lat: point.lat,
      altitudeMeters: altitudeAboveGround(point.lon, point.lat, reportedAltitudeMeters, groundElevation),
      reportedAltitudeMeters,
      headingDegrees,
      trackDegrees: point.track ?? previous?.trackDegrees ?? headingDegrees,
      groundSpeedMetersPerSecond:
        point.ground_speed !== null
          ? point.ground_speed * KNOTS_TO_METERS_PER_SECOND
          : (previous?.groundSpeedMetersPerSecond ?? 0),
    });
  }
  return positions;
}

// `positions` with their altitudes clamped to the ground in `groundElevation` again, as in
// `toTimedPositions`. Altitudes that would change by less than CLAMP_TOLERANCE_METERS are kept.
// Returns `positions` itself if no altitude changed.
export function withGroundClamping(
  positions: readonly TimedPosition[],
  groundElevation: (lng: number, lat: number) => number,
): readonly TimedPosition[] {
  let changed = false;
  const updated = positions.map((position) => {
    const altitudeMeters = altitudeAboveGround(
      position.lng,
      position.lat,
      position.reportedAltitudeMeters,
      groundElevation,
    );
    if (Math.abs(altitudeMeters - position.altitudeMeters) < CLAMP_TOLERANCE_METERS) {
      return position;
    }
    changed = true;
    return { ...position, altitudeMeters };
  });
  return changed ? updated : positions;
}

// `reportedAltitudeMeters` clamped to at least GROUND_CLEARANCE_METERS above the ground at a point in
// `groundElevation`, or to exactly that clearance on the ground. Altitudes above any terrain aren't
// clamped, and the ground isn't looked up for them.
function altitudeAboveGround(
  lng: number,
  lat: number,
  reportedAltitudeMeters: number | null,
  groundElevation: (lng: number, lat: number) => number,
): number {
  if (reportedAltitudeMeters !== null && reportedAltitudeMeters > MAX_TERRAIN_ELEVATION_METERS) {
    return reportedAltitudeMeters;
  }
  const minimumMeters = groundElevation(lng, lat) + GROUND_CLEARANCE_METERS;
  return Math.max(reportedAltitudeMeters ?? minimumMeters, minimumMeters);
}

// The position at `timeMs`, interpolated between the positions around it. After the newest position,
// it is extrapolated along the last track. Returns null before the oldest position.
export function positionAt(positions: readonly TimedPosition[], timeMs: number): FlightPosition | null {
  // Searched from the end, since aircraft are drawn near their newest positions.
  const next = positions.findLastIndex((position) => position.timeMs <= timeMs) + 1;
  if (next === 0) {
    return null;
  }
  if (next === positions.length) {
    return extrapolate(positions[positions.length - 1], timeMs);
  }
  const start = positions[next - 1];
  const end = positions[next];
  const t = (timeMs - start.timeMs) / (end.timeMs - start.timeMs);
  return {
    lng: lerp(start.lng, end.lng, t),
    lat: lerp(start.lat, end.lat, t),
    altitudeMeters: lerp(start.altitudeMeters, end.altitudeMeters, t),
    headingDegrees: lerpDegrees(start.headingDegrees, end.headingDegrees, t),
  };
}

// A smooth curve through `positions`, oldest first, of at most `maxPoints` points. It is a uniform
// cubic B-spline with the positions as control points, so it averages out jitter in the recorded
// positions instead of passing through them. It starts exactly at the oldest position and ends
// exactly at the newest. Times are blended like positions, so they increase along the curve.
export function smoothPath(positions: readonly TimedPosition[], maxPoints: number): PathPoint[] {
  const toPathPoint = ({ lng, lat, altitudeMeters, timeMs }: PathPoint): PathPoint => ({
    lng,
    lat,
    altitudeMeters,
    timeMs,
  });
  if (positions.length < 2) {
    return positions.map(toPathPoint);
  }
  const first = positions[0];
  const last = positions[positions.length - 1];
  // Repeating an end control point three times makes the curve pass through it.
  const controls = [first, first, ...positions, last, last];
  const segments = controls.length - 3;
  const pointsPerSegment = Math.max(1, Math.floor((maxPoints - 1) / segments));
  const curve: PathPoint[] = [];
  for (let segment = 0; segment < segments; segment++) {
    const [p0, p1, p2, p3] = controls.slice(segment, segment + 4);
    for (let step = 0; step < pointsPerSegment; step++) {
      const t = step / pointsPerSegment;
      const [w0, w1, w2, w3] = [
        (1 - t) ** 3 / 6,
        (3 * t ** 3 - 6 * t ** 2 + 4) / 6,
        (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6,
        t ** 3 / 6,
      ];
      const blend = (key: keyof PathPoint) => w0 * p0[key] + w1 * p1[key] + w2 * p2[key] + w3 * p3[key];
      curve.push({
        lng: blend('lng'),
        lat: blend('lat'),
        altitudeMeters: blend('altitudeMeters'),
        timeMs: blend('timeMs'),
      });
    }
  }
  curve.push(toPathPoint(last));
  return curve.slice(-maxPoints);
}

function extrapolate(last: TimedPosition, timeMs: number): FlightPosition {
  const seconds = Math.min(timeMs - last.timeMs, MAX_EXTRAPOLATION_MS) / 1000;
  const meters = last.groundSpeedMetersPerSecond * seconds;
  const track = (last.trackDegrees * Math.PI) / 180;
  return {
    lng: last.lng + (meters * Math.sin(track)) / metersPerDegreeLng(last.lat),
    lat: last.lat + (meters * Math.cos(track)) / METERS_PER_DEGREE,
    altitudeMeters: last.altitudeMeters,
    headingDegrees: last.headingDegrees,
  };
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

// Interpolates between two angles in degrees the short way around.
function lerpDegrees(start: number, end: number, t: number): number {
  const delta = ((((end - start) % 360) + 540) % 360) - 180;
  return start + delta * t;
}
