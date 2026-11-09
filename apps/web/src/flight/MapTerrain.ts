import type { Map as MapboxMap, MapEventOf } from 'mapbox-gl';

import type { Ground } from './AircraftFeed';

// Terrain tiles load in bursts, so listeners are called once loading has paused for this long.
const SETTLE_MS = 250;

// Ground elevation from the terrain of an attached Mapbox map, so that altitudes are clamped to the
// terrain as it is drawn. Mapbox streams terrain in tiles and replaces them with more detailed ones
// as the view zooms in, so the elevation at a point changes as tiles load; `onChange` reports that.
export class MapTerrain implements Ground {
  private map: MapboxMap | null = null;
  private readonly listeners = new Set<() => void>();
  private settleTimer: number | undefined;
  private paused = false;
  // Whether terrain changed while paused.
  private changedWhilePaused = false;

  attach(map: MapboxMap) {
    this.map = map;
    map.on('sourcedata', this.onSourceData);
  }

  detach() {
    this.map?.off('sourcedata', this.onSourceData);
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    this.map = null;
  }

  // Holds changes until `resume`, such as while the camera moves: tiles load throughout a move, and
  // placing every aircraft above them again would stutter the animation.
  pause() {
    this.paused = true;
    if (this.settleTimer !== undefined) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
      this.changedWhilePaused = true;
    }
  }

  // Reports any change held since `pause`.
  resume() {
    this.paused = false;
    if (this.changedWhilePaused) {
      this.changedWhilePaused = false;
      this.settle();
    }
  }

  // Altitude in meters of the terrain at a point, or 0 where it hasn't loaded or no map is attached.
  readonly elevation = (lng: number, lat: number): number =>
    this.map?.queryTerrainElevation([lng, lat]) ?? 0;

  // Calls `listener` after the map's terrain tiles load, when elevations may have changed. Returns a
  // function that unsubscribes it.
  readonly onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private readonly onSourceData = (event: MapEventOf<'sourcedata'>) => {
    const terrainSource = this.map?.getTerrain()?.source;
    if (!terrainSource || event.sourceId !== terrainSource || !event.tile) {
      return;
    }
    if (this.paused) {
      this.changedWhilePaused = true;
    } else {
      this.settle();
    }
  };

  // Calls the listeners once no more terrain tiles have loaded for SETTLE_MS.
  private settle() {
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = undefined;
      for (const listener of this.listeners) {
        listener();
      }
    }, SETTLE_MS);
  }
}
