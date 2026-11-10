import type { ApiAircraft } from './aircraftApi';
import { type TimedPosition, toTimedPositions, withGroundClamping } from './flightTrace';

// The most positions kept per aircraft. Enough for `historyMs` of positions about a second apart,
// the densest that recorded traces have.
const MAX_POSITIONS = 128;

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
  // How far back from now positions are needed.
  historyMs: number;
  ground: Ground;
}

// Holds the aircraft from `GET /aircraft` responses: each one's newest MAX_POSITIONS positions, while
// it has one in the last `historyMs`.
export class AircraftFeed {
  readonly historyMs: number;
  private readonly ground: Ground;
  // Each aircraft's positions, oldest first, by address. Every change replaces the map, and the
  // arrays of aircraft whose positions changed; they are never changed in place.
  private traces = new Map<string, readonly TimedPosition[]>();
  private readonly listeners = new Set<() => void>();
  // Stops listening to `ground`. Set only while there are aircraft, so a feed that is dropped before
  // its first response, or after it's cleared, leaves no listener behind.
  private unsubscribeGround: (() => void) | null = null;

  constructor({ historyMs, ground }: AircraftFeedOptions) {
    this.historyMs = historyMs;
    this.ground = ground;
  }

  // Replaces the aircraft with `aircraft`.
  setAircraft(aircraft: readonly ApiAircraft[]) {
    this.traces = new Map();
    this.addAircraft(aircraft);
  }

  // Adds the positions in `aircraft` newer than each aircraft's newest, and drops the aircraft with
  // no position in the last `historyMs`. `aircraft` may repeat positions the feed already has.
  addAircraft(aircraft: readonly ApiAircraft[]) {
    const traces = new Map(this.traces);
    for (const { aircraft_address: address, trace } of aircraft) {
      const positions = traces.get(address) ?? [];
      const newestMs = positions.at(-1)?.timeMs ?? -Infinity;
      const newPoints = trace.filter((point) => point.observed_at > newestMs);
      if (newPoints.length > 0) {
        const added = toTimedPositions(newPoints, this.ground.elevation, positions.at(-1));
        traces.set(address, [...positions, ...added].slice(-MAX_POSITIONS));
      }
    }
    const oldestMs = Date.now() - this.historyMs;
    for (const [address, positions] of traces) {
      if (positions[positions.length - 1].timeMs < oldestMs) {
        traces.delete(address);
      }
    }
    this.setTraces(traces);
  }

  clear() {
    this.setTraces(new Map());
  }

  // Each aircraft's positions, oldest first, by address.
  aircraft(): ReadonlyMap<string, readonly TimedPosition[]> {
    return this.traces;
  }

  // Calls `listener` whenever the aircraft change. Returns a function that unsubscribes it.
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setTraces(traces: Map<string, readonly TimedPosition[]>) {
    this.traces = traces;
    this.listenToGround(traces.size > 0);
    this.notify();
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
