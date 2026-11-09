// Meters in a degree of latitude, and in a degree of longitude at the equator.
export const METERS_PER_DEGREE = 111_320;

// Meters in a degree of longitude at latitude `lat`.
export function metersPerDegreeLng(lat: number): number {
  return METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
}

// Wraps a longitude into [-180, 180).
export function wrapLongitude(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}
