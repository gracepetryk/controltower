import type { FlightPosition } from './types';

const METERS_PER_DEGREE_LAT = 111_320;

interface Orbit {
  center: [number, number];
  radiusMeters: number;
  lapMs: number;
  altitudeMeters: number;
  // Altitude varies sinusoidally by this much over each lap.
  altitudeSwingMeters: number;
}

// Returns the position at `timeMs` of an aircraft flying counterclockwise laps around `orbit.center`.
export function orbitPosition(orbit: Orbit, timeMs: number): FlightPosition {
  const [centerLng, centerLat] = orbit.center;
  const angle = (2 * Math.PI * timeMs) / orbit.lapMs;

  const eastMeters = orbit.radiusMeters * Math.cos(angle);
  const northMeters = orbit.radiusMeters * Math.sin(angle);
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos((centerLat * Math.PI) / 180);

  return {
    lng: centerLng + eastMeters / metersPerDegreeLng,
    lat: centerLat + northMeters / METERS_PER_DEGREE_LAT,
    altitudeMeters: orbit.altitudeMeters + orbit.altitudeSwingMeters * Math.sin(angle),
    // The velocity of a counterclockwise orbit points along (-sin, cos) in (east, north).
    headingDegrees: (Math.atan2(-Math.sin(angle), Math.cos(angle)) * 180) / Math.PI,
  };
}
