import type * as THREE from 'three';

import { positionAt, smoothPath, type TimedPosition } from './flightTrace';
import type { FlightPosition } from './types';

// Converts positions into a scene and limits how many points each trail has there.
export interface TrackScene {
  // The point in the scene at a position. Must stay the same for the life of the track.
  scenePoint: (position: Pick<FlightPosition, 'lng' | 'lat' | 'altitudeMeters'>) => THREE.Vector3;
  // The most points in each trail, including the aircraft itself.
  maxTrailPoints: number;
}

// One aircraft's trace, prepared for drawing: smoothed and converted to scene coordinates once
// rather than every frame.
export class AircraftTrack {
  readonly trace: readonly TimedPosition[];
  // `trace` smoothed into a curve in the scene, oldest first, and the time at each point. Built on
  // the first `trailAt`, from the position its trail starts after, since trails only get later.
  private path: { points: THREE.Vector3[]; timesMs: number[] } | null = null;

  constructor(trace: readonly TimedPosition[]) {
    this.trace = trace;
  }

  // The aircraft's position at `timeMs`, or null before its oldest position or long after its newest.
  positionAt(timeMs: number): FlightPosition | null {
    return positionAt(this.trace, timeMs);
  }

  // The trail in `scene` in the `trailMs` before `timeMs`, oldest first, faded from 0 at its oldest
  // point to 1 at `timeMs`. The trail starts at the oldest point of the path if that is within the
  // window.
  trailAt(timeMs: number, trailMs: number, scene: TrackScene): { points: THREE.Vector3[]; fades: number[] } {
    const { points, timesMs } = (this.path ??= this.buildPath(timeMs - trailMs, scene));
    const startMs = Math.max(timeMs - trailMs, timesMs[0]);
    const spanMs = timeMs - startMs;
    const trailPoints: THREE.Vector3[] = [];
    const fades: number[] = [];
    if (spanMs <= 0) {
      return { points: trailPoints, fades };
    }
    let next = timesMs.findIndex((pointMs) => pointMs > startMs);
    if (next === -1) {
      next = points.length;
    }
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

  // The path from the newest position at or before `startMs`, or from the oldest if none is.
  private buildPath(startMs: number, scene: TrackScene): NonNullable<AircraftTrack['path']> {
    const first = Math.max(this.trace.findLastIndex((position) => position.timeMs <= startMs), 0);
    // Leaves room for the interpolated start of the trail and the aircraft itself.
    const path = smoothPath(this.trace.slice(first), scene.maxTrailPoints - 2);
    return {
      points: path.map((point) => scene.scenePoint(point)),
      timesMs: path.map((point) => point.timeMs),
    };
  }
}
