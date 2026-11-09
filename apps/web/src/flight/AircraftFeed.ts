import type { AircraftResponse } from './aircraftApi';
import { type TimedPosition, toTimedPositions, withGroundClamping } from './flightTrace';

// The server's clock is resynced when it drifts from ours by more than this, such as when a
// replayed day wraps around.
const MAX_CLOCK_DRIFT_MS = 1_000;

// Where the ground is, for clamping altitudes to it.
//
// The elevation at a point can change over time. Altitudes are clamped to the terrain as the map
// draws it, and a map loads its terrain in tiles as the view moves, starting coarse and adding
// detail as you zoom in. Until a tile loads, the ground there is unknown, and once it does, a hill
// can turn out higher or lower than the coarser tile showed. `onChange` reports when that happens so
// the altitudes can be clamped to the new ground.
export interface Ground {
  // Altitude in meters of the ground at a point, as currently known.
  elevation: (lng: number, lat: number) => number;
  // Calls `listener` when elevations may have changed. Returns a function that unsubscribes it.
  onChange: (listener: () => void) => () => void;
}

interface AircraftFeedOptions {
  // How far back before the server's `now` positions are needed.
  historyMs: number;
  ground: Ground;
}

// Holds the aircraft from the latest `GET /aircraft` response and keeps track of the server's clock,
// which may be replaying a past day.
export class AircraftFeed {
  readonly historyMs: number;
  private readonly ground: Ground;
  // Each aircraft's positions, oldest first, by address. Each response replaces the map and its
  // arrays; they are never changed in place.
  private traces = new Map<string, readonly TimedPosition[]>();
  // Server time minus local time.
  private clockOffsetMs: number | null = null;
  private readonly listeners = new Set<() => void>();
  // Stops listening to `ground`. Set only while there are aircraft, so a feed that is dropped before
  // its first response, or after it's cleared, leaves no listener behind.
  private unsubscribeGround: (() => void) | null = null;

  constructor({ historyMs, ground }: AircraftFeedOptions) {
    this.historyMs = historyMs;
    this.ground = ground;
  }

  // Replaces the aircraft with those in `response`, for a request sent at `requestedMs` and answered
  // at `receivedMs` by the local clock.
  setAircraft(response: AircraftResponse, requestedMs: number, receivedMs: number) {
    // The server read its clock about halfway through the request.
    const offsetMs = response.now - (requestedMs + receivedMs) / 2;
    if (this.clockOffsetMs === null || Math.abs(offsetMs - this.clockOffsetMs) > MAX_CLOCK_DRIFT_MS) {
      this.clockOffsetMs = offsetMs;
    }
    this.traces = new Map(
      response.aircraft.map(({ aircraft_address: address, trace }) => [
        address,
        toTimedPositions(trace, this.ground.elevation),
      ]),
    );
    this.listenToGround(this.traces.size > 0);
    this.notify();
  }

  clear() {
    this.traces = new Map();
    this.listenToGround(false);
    this.notify();
  }

  // Each aircraft's positions, oldest first, by address.
  aircraft(): ReadonlyMap<string, readonly TimedPosition[]> {
    return this.traces;
  }

  // The server's current time in milliseconds since the Unix epoch, or null before the first
  // response.
  serverNow(): number | null {
    return this.clockOffsetMs === null ? null : Date.now() + this.clockOffsetMs;
  }

  // Calls `listener` whenever the aircraft are replaced. Returns a function that unsubscribes it.
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private listenToGround(listen: boolean) {
    if (listen && !this.unsubscribeGround) {
      this.unsubscribeGround = this.ground.onChange(() => this.updateGroundClamping());
    } else if (!listen && this.unsubscribeGround) {
      this.unsubscribeGround();
      this.unsubscribeGround = null;
    }
  }

  // Clamps every position to the ground again, and replaces the traces whose altitudes changed.
  // Called when the ground changes, so that aircraft on or near the ground follow the terrain as it
  // loads instead of waiting for the next response.
  private updateGroundClamping() {
    let changed = false;
    const traces = new Map<string, readonly TimedPosition[]>();
    for (const [address, trace] of this.traces) {
      const updated = withGroundClamping(trace, this.ground.elevation);
      changed ||= updated !== trace;
      traces.set(address, updated);
    }
    if (changed) {
      this.traces = traces;
      this.notify();
    }
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
