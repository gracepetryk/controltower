import mapboxgl from 'mapbox-gl';
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

import type { AircraftFeed } from './AircraftFeed';
import { AircraftTrack } from './AircraftTrack';
import { FadingTrails } from './FadingTrails';
import { A320_LENGTH_METERS, buildPlaneGeometry } from './planeModel';
import type { FlightPosition } from './types';

// Planes are scaled up when zoomed out so they stay at least this long on screen.
const MIN_PLANE_LENGTH_PIXELS = 16;
const MAPBOX_TILE_SIZE = 512;
const TRAIL_COLOR = '#ff8c1a';
const DROP_LINE_COLOR = '#ffffff';
const UP = new THREE.Vector3(0, 0, 1);

interface AircraftLayerOptions {
  // Where the aircraft come from. Read on every render.
  feed: AircraftFeed;
  // Aircraft are drawn this far behind the feed's server clock.
  delayMs: number;
  // How far back each trail reaches.
  trailMs: number;
  // Aircraft positions are stored relative to this [lng, lat].
  origin: [number, number];
  maxAircraft: number;
  // The most points in each trail, including the aircraft itself.
  maxTrailPoints: number;
}

interface Aircraft {
  position: FlightPosition;
  // Position in the scene frame.
  point: THREE.Vector3;
  // Scene units per meter at the aircraft's latitude.
  metersToScene: number;
  trailSlot: number;
}

// Mapbox custom layer that renders any number of 3D planes, up to `maxAircraft`, each with a fading
// trail and a faint vertical line down to the ground. All planes, trails
// and drop lines are each drawn in a single instanced draw call.
export class AircraftLayer implements mapboxgl.CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom';
  readonly renderingMode = '3d';

  // The scene uses a local frame centered on `origin`: x east, y north, z up, in meters at the
  // origin's latitude. Away from it, a meter is `Aircraft.metersToScene` scene units.
  private readonly origin: mapboxgl.MercatorCoordinate;
  private readonly sceneToMercator: THREE.Matrix4;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly planes: THREE.InstancedMesh;
  private readonly trails: FadingTrails;
  private readonly dropLineMaterial = new LineMaterial({
    color: DROP_LINE_COLOR,
    linewidth: 1,
    transparent: true,
    opacity: 0.35,
  });
  private readonly dropLineGeometry = new LineSegmentsGeometry();
  // Start and end xyz of each drop line, packed from the front each render.
  private readonly dropLinePositions: Float32Array;
  private readonly aircraft = new Map<string, Aircraft>();
  private readonly freeTrailSlots: number[];
  readonly maxAircraft: number;
  readonly maxTrailPoints: number;
  private readonly feed: AircraftFeed;
  private readonly delayMs: number;
  private readonly trailMs: number;
  // Each aircraft's trace from the feed, prepared for drawing, by address.
  private readonly tracks = new Map<string, AircraftTrack>();
  private map: mapboxgl.Map | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private unsubscribe: (() => void) | null = null;
  private warnedFull = false;
  private warnedRenderError = false;

  constructor(
    id: string,
    { feed, delayMs, trailMs, origin, maxAircraft, maxTrailPoints }: AircraftLayerOptions,
  ) {
    this.id = id;
    this.feed = feed;
    this.delayMs = delayMs;
    this.trailMs = trailMs;
    this.maxAircraft = maxAircraft;
    this.maxTrailPoints = maxTrailPoints;
    this.origin = mapboxgl.MercatorCoordinate.fromLngLat(origin);
    const metersToMercator = this.origin.meterInMercatorCoordinateUnits();
    // Mercator y grows southward, so north is flipped.
    this.sceneToMercator = new THREE.Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, 0)
      .scale(new THREE.Vector3(metersToMercator, -metersToMercator, metersToMercator));

    this.planes = new THREE.InstancedMesh(
      buildPlaneGeometry(),
      new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      maxAircraft,
    );
    this.planes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.planes.count = 0;
    this.planes.frustumCulled = false;

    this.trails = new FadingTrails({
      color: TRAIL_COLOR,
      linewidth: 2,
      maxTrails: maxAircraft,
      maxPoints: maxTrailPoints,
    });
    // Popped from the end, so slots are handed out from 0.
    this.freeTrailSlots = Array.from({ length: maxAircraft }, (_, i) => maxAircraft - 1 - i);

    this.dropLinePositions = new Float32Array(maxAircraft * 6);
    this.dropLineGeometry.setPositions(this.dropLinePositions);
    this.dropLineGeometry.instanceCount = 0;
    const dropLines = new LineSegments2(this.dropLineGeometry, this.dropLineMaterial);
    dropLines.frustumCulled = false;

    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(0.5, -1, 2);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5), sun, this.planes, this.trails, dropLines);
  }

  // Adds the aircraft `id` at `position`, or moves it there, and replaces its trail with
  // `trailPoints`, oldest first, from `scenePoint`, each with an opacity in `trailFades`. The trail
  // continues to the aircraft at full opacity. Throws if adding it would exceed `maxAircraft`, or if
  // the trail has `maxTrailPoints` points or more.
  private setAircraft(id: string, position: FlightPosition, trailPoints: THREE.Vector3[], trailFades: number[]) {
    const { point, metersToScene } = this.toScene(position);
    let aircraft = this.aircraft.get(id);
    if (!aircraft) {
      const trailSlot = this.freeTrailSlots.pop();
      if (trailSlot === undefined) {
        throw new Error(`AircraftLayer holds at most ${this.maxAircraft} aircraft; cannot add ${id}`);
      }
      aircraft = { position, point, metersToScene, trailSlot };
      this.aircraft.set(id, aircraft);
    }
    aircraft.position = position;
    aircraft.point = point;
    aircraft.metersToScene = metersToScene;
    this.trails.setTrail(aircraft.trailSlot, [...trailPoints, point], [...trailFades, 1]);
  }

  private removeAircraft(id: string) {
    const aircraft = this.aircraft.get(id);
    if (!aircraft) {
      return;
    }
    this.trails.clearTrail(aircraft.trailSlot);
    this.freeTrailSlots.push(aircraft.trailSlot);
    this.aircraft.delete(id);
  }

  // Sets every aircraft to its position as of `delayMs` ago, and removes the ones that have none.
  // Aircraft beyond `maxAircraft` are skipped.
  private syncWithFeed() {
    this.updateTracks();
    const timeMs = Date.now() - this.delayMs;
    const positions = new Map<string, FlightPosition>();
    for (const [address, track] of this.tracks) {
      const position = track.positionAt(timeMs);
      if (position) {
        positions.set(address, position);
      }
    }
    // Removing first frees room for the aircraft that are added.
    for (const id of this.aircraft.keys()) {
      if (!positions.has(id)) {
        this.removeAircraft(id);
      }
    }
    for (const [address, position] of positions) {
      if (!this.aircraft.has(address) && this.aircraft.size >= this.maxAircraft) {
        if (!this.warnedFull) {
          console.warn(`More than ${this.maxAircraft} aircraft in view; skipping the rest`);
          this.warnedFull = true;
        }
        continue;
      }
      const { points, fades } = this.tracks.get(address)!.trailAt(timeMs!, this.trailMs, this);
      this.setAircraft(address, position, points, fades);
    }
  }

  // Makes `tracks` match the feed: a new track for each new or changed trace, and none for aircraft
  // the feed no longer has.
  private updateTracks() {
    const traces = this.feed.aircraft();
    for (const address of this.tracks.keys()) {
      if (!traces.has(address)) {
        this.tracks.delete(address);
      }
    }
    for (const [address, trace] of traces) {
      if (this.tracks.get(address)?.trace !== trace) {
        this.tracks.set(address, new AircraftTrack(trace));
      }
    }
  }

  onAdd(map: mapboxgl.Map, gl: WebGL2RenderingContext) {
    this.map = map;
    // The feed's aircraft are read on render, which Mapbox only runs when something changes.
    this.unsubscribe = this.feed.subscribe(() => map.triggerRepaint());
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  }

  onRemove() {
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    this.renderer?.dispose();
    this.renderer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.map = null;
  }

  render(gl: WebGL2RenderingContext, matrix: number[]) {
    if (!this.renderer || !this.map) {
      return;
    }
    try {
      this.syncWithFeed();
      if (this.aircraft.size > 0) {
        this.drawScene(this.renderer, this.map.getZoom(), gl, matrix);
      }
    } catch (error) {
      // Thrown out of render, the error would also stop Mapbox from drawing the rest of the map.
      // Logged once, since it would likely repeat every frame.
      if (!this.warnedRenderError) {
        console.error('Drawing aircraft failed', error);
        this.warnedRenderError = true;
      }
    } finally {
      // Aircraft move every frame, and ones not yet shown appear as the drawn time catches up to
      // their trace, so keep rendering while there are any tracks.
      if (this.tracks.size > 0) {
        this.map.triggerRepaint();
      }
    }
  }

  private drawScene(renderer: THREE.WebGLRenderer, zoom: number, gl: WebGL2RenderingContext, matrix: number[]) {
    this.updateInstances(zoom);
    this.trails.setResolution(gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.dropLineMaterial.resolution.set(gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.camera.projectionMatrix.fromArray(matrix).multiply(this.sceneToMercator);

    renderer.resetState();
    renderer.render(this.scene, this.camera);
  }

  // Writes each aircraft's plane transform and drop line, packed from the front of their buffers.
  private updateInstances(zoom: number) {
    // The scene is linear in Mercator, so a screen pixel spans the same scene distance everywhere.
    const sceneUnitsPerPixel = 1 / (MAPBOX_TILE_SIZE * 2 ** zoom * this.origin.meterInMercatorCoordinateUnits());
    const minPlaneScale = (MIN_PLANE_LENGTH_PIXELS * sceneUnitsPerPixel) / A320_LENGTH_METERS;
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const transform = new THREE.Matrix4();

    let planeCount = 0;
    let dropLineCount = 0;
    for (const { position, point, metersToScene } of this.aircraft.values()) {
      rotation.setFromAxisAngle(UP, -THREE.MathUtils.degToRad(position.headingDegrees));
      scale.setScalar(Math.max(metersToScene, minPlaneScale));
      this.planes.setMatrixAt(planeCount++, transform.compose(point, rotation, scale));

      if (point.z > 0) {
        this.dropLinePositions.set([point.x, point.y, 0, point.x, point.y, point.z], dropLineCount++ * 6);
      }
    }

    this.planes.count = planeCount;
    this.planes.instanceMatrix.needsUpdate = true;
    this.dropLineGeometry.instanceCount = dropLineCount;
    (this.dropLineGeometry.attributes.instanceStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
  }

  // The point in the scene frame at a position.
  scenePoint(position: Pick<FlightPosition, 'lng' | 'lat' | 'altitudeMeters'>): THREE.Vector3 {
    return this.toScene(position).point;
  }

  private toScene({ lng, lat, altitudeMeters }: Pick<FlightPosition, 'lng' | 'lat' | 'altitudeMeters'>): {
    point: THREE.Vector3;
    metersToScene: number;
  } {
    const coordinate = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], altitudeMeters);
    const originMetersToMercator = this.origin.meterInMercatorCoordinateUnits();
    return {
      point: new THREE.Vector3(
        (coordinate.x - this.origin.x) / originMetersToMercator,
        -(coordinate.y - this.origin.y) / originMetersToMercator,
        coordinate.z / originMetersToMercator,
      ),
      metersToScene: coordinate.meterInMercatorCoordinateUnits() / originMetersToMercator,
    };
  }
}
