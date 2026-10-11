import mapboxgl from 'mapbox-gl';
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

import { FadingTrails } from './FadingTrails';
import { A320_LENGTH_METERS, buildPlaneGeometry } from './planeModel';
import type { FlightPosition } from './types';

// Planes are scaled up when zoomed out so they stay at least this long on screen.
const MIN_PLANE_LENGTH_PIXELS = 16;
const TRAIL_MIN_SPACING_METERS = 25;
const MAX_TRAIL_POINTS = 100;
const MAPBOX_TILE_SIZE = 512;
const TRAIL_COLOR = '#ff8c1a';
const DROP_LINE_COLOR = '#ffffff';
const UP = new THREE.Vector3(0, 0, 1);

interface AircraftLayerOptions {
  // Aircraft positions are stored relative to this [lng, lat].
  origin: [number, number];
  maxAircraft: number;
}

interface Aircraft {
  position: FlightPosition;
  // Position in the scene frame.
  point: THREE.Vector3;
  // Scene units per meter at the aircraft's latitude.
  metersToScene: number;
  trailSlot: number;
  trailPoints: THREE.Vector3[];
  lastTrailHeadingDegrees: number;
}

// Unit vector in the scene frame pointing along a heading in degrees clockwise from north.
function headingDirection(headingDegrees: number): THREE.Vector3 {
  const heading = THREE.MathUtils.degToRad(headingDegrees);
  return new THREE.Vector3(Math.sin(heading), Math.cos(heading), 0);
}

// A curve from `start` to `end` that leaves along `startHeadingDegrees` and arrives along
// `endHeadingDegrees`. Its tangents scale with the horizontal distance, and altitude changes linearly.
function trailCurve(
  start: THREE.Vector3,
  startHeadingDegrees: number,
  end: THREE.Vector3,
  endHeadingDegrees: number,
): THREE.CubicBezierCurve3 {
  const horizontalDistance = Math.hypot(end.x - start.x, end.y - start.y);
  const climb = new THREE.Vector3(0, 0, end.z - start.z);
  const tangent = (headingDegrees: number) =>
    headingDirection(headingDegrees).multiplyScalar(horizontalDistance).add(climb).divideScalar(3);
  return new THREE.CubicBezierCurve3(
    start,
    start.clone().add(tangent(startHeadingDegrees)),
    end.clone().sub(tangent(endHeadingDegrees)),
    end,
  );
}

// Trail points after `start` and ending at `end`, about `spacing` apart along a curve that matches
// the heading at both ends. Fills gaps, such as while the page is hidden and no frames run.
// Returns at most MAX_TRAIL_POINTS points.
function trailPointsBetween(
  start: THREE.Vector3,
  startHeadingDegrees: number,
  end: THREE.Vector3,
  endHeadingDegrees: number,
  spacing: number,
): THREE.Vector3[] {
  const curve = trailCurve(start, startHeadingDegrees, end, endHeadingDegrees);
  const divisions = Math.max(1, Math.floor(curve.getLength() / spacing));
  const points: THREE.Vector3[] = [];
  for (let i = Math.max(1, divisions - MAX_TRAIL_POINTS + 1); i < divisions; i++) {
    points.push(curve.getPointAt(i / divisions));
  }
  points.push(end);
  return points;
}

// Mapbox custom layer that renders any number of 3D planes, up to `maxAircraft`, each with a trail
// through its previous positions and a faint vertical line down to the ground. All planes, trails
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
  private readonly maxAircraft: number;
  private map: mapboxgl.Map | null = null;
  private renderer: THREE.WebGLRenderer | null = null;

  constructor(id: string, { origin, maxAircraft }: AircraftLayerOptions) {
    this.id = id;
    this.maxAircraft = maxAircraft;
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
      maxPoints: MAX_TRAIL_POINTS,
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

  // Adds the aircraft `id` at `position`, or moves it there and extends its trail. Throws if adding
  // it would exceed `maxAircraft`.
  setAircraft(id: string, position: FlightPosition) {
    const { point, metersToScene } = this.toScene(position);
    let aircraft = this.aircraft.get(id);
    if (!aircraft) {
      const trailSlot = this.freeTrailSlots.pop();
      if (trailSlot === undefined) {
        throw new Error(`AircraftLayer holds at most ${this.maxAircraft} aircraft; cannot add ${id}`);
      }
      aircraft = {
        position,
        point,
        metersToScene,
        trailSlot,
        trailPoints: [],
        lastTrailHeadingDegrees: position.headingDegrees,
      };
      this.aircraft.set(id, aircraft);
    }
    aircraft.position = position;
    aircraft.point = point;
    aircraft.metersToScene = metersToScene;
    this.extendTrail(aircraft);

    this.map?.triggerRepaint();
  }

  removeAircraft(id: string) {
    const aircraft = this.aircraft.get(id);
    if (!aircraft) {
      return;
    }
    this.trails.clearTrail(aircraft.trailSlot);
    this.freeTrailSlots.push(aircraft.trailSlot);
    this.aircraft.delete(id);

    this.map?.triggerRepaint();
  }

  onAdd(map: mapboxgl.Map, gl: WebGL2RenderingContext) {
    this.map = map;
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
    this.map = null;
  }

  render(gl: WebGL2RenderingContext, matrix: number[]) {
    if (!this.renderer || !this.map || this.aircraft.size === 0) {
      return;
    }

    this.updateInstances(this.map.getZoom());
    this.trails.setResolution(gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.dropLineMaterial.resolution.set(gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.camera.projectionMatrix.fromArray(matrix).multiply(this.sceneToMercator);

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
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

  // Appends points to the aircraft's trail once it has moved at least TRAIL_MIN_SPACING_METERS from
  // the last trail point.
  private extendTrail(aircraft: Aircraft) {
    const { point, position, trailPoints } = aircraft;
    const spacing = TRAIL_MIN_SPACING_METERS * aircraft.metersToScene;
    const last = trailPoints.at(-1);
    if (last && last.distanceTo(point) < spacing) {
      return;
    }

    trailPoints.push(
      ...(last
        ? trailPointsBetween(last, aircraft.lastTrailHeadingDegrees, point, position.headingDegrees, spacing)
        : [point]),
    );
    trailPoints.splice(0, trailPoints.length - MAX_TRAIL_POINTS);
    aircraft.lastTrailHeadingDegrees = position.headingDegrees;
    this.trails.setTrail(aircraft.trailSlot, trailPoints);
  }

  private toScene({ lng, lat, altitudeMeters }: FlightPosition): { point: THREE.Vector3; metersToScene: number } {
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
