export interface FlightPosition {
  lng: number;
  lat: number;
  altitudeMeters: number;
  // Degrees clockwise from true north.
  headingDegrees: number;
}
