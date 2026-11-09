import type * as THREE from 'three';

import type { AircraftLayer } from './AircraftLayer';
import { AreaTooLargeError, type BoundingBox, fetchAircraft, padBoundingBox } from './aircraftApi';
import {
  clampToGround,
  positionAt,
  smoothPath,
  type TimedPosition,
  toTimedPositions,
} from './flightTrace';

const POLL_INTERVAL_MS = 5_000;
// Aircraft are drawn this far behind the server's clock. The newest stored position is usually 10 to
// 35 s old, so most aircraft have a recorded position after the drawn time to interpolate toward.
const DISPLAY_DELAY_MS = 40_000;
// The server's clock is resynced when it drifts from ours by more than this, such as when a
// replayed day wraps around.
const MAX_CLOCK_DRIFT_MS = 1_000;
// Each aircraft's altitudes are clamped to the terrain this often, since terrain loads and sharpens
// after the positions arrive. The work is spread across frames.
const GROUND_CLAMP_INTERVAL_MS = 1_000;
// Faster than airliners fly over the ground, even with a strong tailwind. The fetched area is padded
// by how far this goes in the trace, so trails and interpolation don't stop at the edge of the view.
const MAX_GROUND_SPEED_MPS = 350;

interface AircraftFeedOptions {
  // How far back each trail reaches.
  trailMs: number;
  // The area to fetch aircraft in.
  bounds: () => BoundingBox;
  // Altitude in meters of the ground at a point, as drawn.
  groundElevation: (lng: number, lat: number) => number;
}

interface TrackedAircraft {
  positions: TimedPosition[];
  // `positions` smoothed into a curve in the scene frame, oldest first, and the time at each point.
  // Built on the next draw when null.
  path: { points: THREE.Vector3[]; timesMs: number[] } | null;
}

// Polls the API for aircraft and their recent traces, and draws them as of the server's clock,
// which may be replaying a past day. Polling pauses while the page is hidden and resumes with an
// immediate poll, so trails cover the time away with recorded positions.
export class AircraftFeed {
  private readonly options: AircraftFeedOptions;
  private aircraft = new Map<string, TrackedAircraft>();
  // Server time minus local time.
  private clockOffsetMs: number | null = null;
  private readonly abort = new AbortController();
  private pollTimer: number | undefined;
  private polling = false;
  // Aircraft are clamped to the ground in turn, starting from this index in `aircraft`.
  private groundClampCursor = 0;
  private lastDrawMs: number | null = null;
  private warnedFull = false;
  // The last area the server refused as too large.
  private tooLargeBounds: BoundingBox | null = null;

  constructor(options: AircraftFeedOptions) {
    this.options = options;
  }

  start() {
    document.addEventListener('visibilitychange', this.onVisibilityChange, { signal: this.abort.signal });
    void this.poll();
  }

  stop() {
    this.abort.abort();
    clearTimeout(this.pollTimer);
  }

  // Sets every aircraft on `layer` to its position as of the server's clock, and removes the ones
  // that are no longer in the feed. Aircraft beyond the layer's `maxAircraft` are skipped.
  draw(layer: AircraftLayer) {
    if (this.clockOffsetMs === null) {
      return;
    }
    this.clampSomeToGround();
    const timeMs = Date.now() + this.clockOffsetMs - DISPLAY_DELAY_MS;
    const positions = new Map<string, ReturnType<typeof positionAt>>();
    for (const [address, { positions: trace }] of this.aircraft) {
      positions.set(address, positionAt(trace, timeMs));
    }
    // Removing first frees room for the aircraft that are added.
    for (const address of layer.aircraftIds()) {
      if (!positions.get(address)) {
        layer.removeAircraft(address);
      }
    }
    for (const [address, position] of positions) {
      if (!position) {
        continue;
      }
      if (!layer.hasAircraft(address) && layer.aircraftCount >= layer.maxAircraft) {
        if (!this.warnedFull) {
          console.warn(`More than ${layer.maxAircraft} aircraft in view; skipping the rest`);
          this.warnedFull = true;
        }
        continue;
      }
      const aircraft = this.aircraft.get(address)!;
      aircraft.path ??= this.buildPath(aircraft.positions, layer);
      const { points, fades } = this.trailAt(aircraft.path, timeMs);
      layer.setAircraft(address, position, points, fades);
    }
  }

  private buildPath(positions: TimedPosition[], layer: AircraftLayer): NonNullable<TrackedAircraft['path']> {
    // Leaves room for the interpolated start of the trail and the aircraft itself.
    const path = smoothPath(positions, layer.maxTrailPoints - 2);
    return {
      points: path.map((point) => layer.scenePoint(point)),
      timesMs: path.map((point) => point.timeMs),
    };
  }

  // The part of `path` in the `trailMs` before `timeMs`, faded from 0 at its oldest point to 1 at
  // `timeMs`. The trail starts at the oldest point of the path if that is within the window.
  private trailAt(
    { points, timesMs }: NonNullable<TrackedAircraft['path']>,
    timeMs: number,
  ): { points: THREE.Vector3[]; fades: number[] } {
    const startMs = Math.max(timeMs - this.options.trailMs, timesMs[0]);
    const spanMs = timeMs - startMs;
    const trailPoints: THREE.Vector3[] = [];
    const fades: number[] = [];
    if (spanMs <= 0) {
      return { points: trailPoints, fades };
    }
    let next = firstIndexAfter(timesMs, startMs);
    if (next === 0) {
      trailPoints.push(points[0]);
      fades.push(0);
      next = 1;
    } else if (next < points.length) {
      const t = (startMs - timesMs[next - 1]) / (timesMs[next] - timesMs[next - 1]);
      trailPoints.push(points[next - 1].clone().lerp(points[next], t));
      fades.push(0);
    }
    for (let i = next; i < points.length && timesMs[i] < timeMs; i++) {
      trailPoints.push(points[i]);
      fades.push((timesMs[i] - startMs) / spanMs);
    }
    return { points: trailPoints, fades };
  }

  // Clamps the next aircraft in turn to the ground, so that each is clamped about once per
  // GROUND_CLAMP_INTERVAL_MS without clamping all of them in one frame.
  private clampSomeToGround() {
    const nowMs = performance.now();
    const elapsedMs = this.lastDrawMs === null ? 0 : nowMs - this.lastDrawMs;
    this.lastDrawMs = nowMs;
    const all = [...this.aircraft.values()];
    const count = Math.min(all.length, Math.ceil((all.length * elapsedMs) / GROUND_CLAMP_INTERVAL_MS));
    for (let i = 0; i < count; i++) {
      this.groundClampCursor %= all.length;
      this.clampToGround(all[this.groundClampCursor++]);
    }
  }

  private clampToGround(aircraft: TrackedAircraft) {
    if (clampToGround(aircraft.positions, this.options.groundElevation)) {
      aircraft.path = null;
    }
  }

  private readonly onVisibilityChange = () => {
    if (!document.hidden) {
      clearTimeout(this.pollTimer);
      void this.poll();
    }
  };

  private async poll() {
    if (this.polling || document.hidden || this.abort.signal.aborted) {
      return;
    }
    // The trace has to reach back to the oldest trail point at the delayed draw time.
    const traceSeconds = Math.ceil((this.options.trailMs + DISPLAY_DELAY_MS + POLL_INTERVAL_MS) / 1000);
    const bounds = padBoundingBox(this.options.bounds(), MAX_GROUND_SPEED_MPS * traceSeconds);
    // The server already refused this area, so it isn't requested again until the view changes.
    if (this.tooLargeBounds && sameBounds(bounds, this.tooLargeBounds)) {
      this.schedulePoll();
      return;
    }
    this.polling = true;
    try {
      await this.fetchAircraft(bounds, traceSeconds);
      this.tooLargeBounds = null;
    } catch (error) {
      if (error instanceof AreaTooLargeError) {
        // Zoomed out too far for the server, so no aircraft are shown.
        this.tooLargeBounds = bounds;
        this.aircraft = new Map();
      } else if (!this.abort.signal.aborted) {
        console.error('Polling aircraft failed; retrying', error);
      }
    } finally {
      this.polling = false;
    }
    this.schedulePoll();
  }

  private schedulePoll() {
    if (!this.abort.signal.aborted) {
      this.pollTimer = window.setTimeout(() => void this.poll(), POLL_INTERVAL_MS);
    }
  }

  private async fetchAircraft(bounds: BoundingBox, traceSeconds: number) {
    const requestedMs = Date.now();
    const response = await fetchAircraft(bounds, traceSeconds, this.abort.signal);
    // The server read its clock about halfway through the request.
    const offsetMs = response.now - (requestedMs + Date.now()) / 2;
    if (this.clockOffsetMs === null || Math.abs(offsetMs - this.clockOffsetMs) > MAX_CLOCK_DRIFT_MS) {
      this.clockOffsetMs = offsetMs;
    }
    this.aircraft = new Map(
      response.aircraft.map(({ aircraft_address: address, trace }) => [
        address,
        { positions: toTimedPositions(trace), path: null },
      ]),
    );
    for (const aircraft of this.aircraft.values()) {
      clampToGround(aircraft.positions, this.options.groundElevation);
    }
  }
}

function sameBounds(a: BoundingBox, b: BoundingBox): boolean {
  return a.every((value, i) => value === b[i]);
}

// The index of the first of `sorted` that is greater than `value`, or `sorted.length` if none is.
function firstIndexAfter(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] > value) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}
