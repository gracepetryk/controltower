import mapboxgl from 'mapbox-gl';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

import { FadingTrail } from './FadingTrail';
import type { FlightPosition } from './types';

// The plane is scaled up when zoomed out so it stays at least this long on screen.
const MIN_PLANE_LENGTH_PIXELS = 16;
const TRAIL_MIN_SPACING_METERS = 25;
const MAX_TRAIL_POINTS = 100;
const EARTH_CIRCUMFERENCE_METERS = 40_075_016.686;
const MAPBOX_TILE_SIZE = 512;
const TRAIL_COLOR = '#ff8c1a';
const DROP_LINE_COLOR = '#ffffff';

// Airbus A320-200 dimensions.
const A320_LENGTH_METERS = 37.57;
const A320_WINGSPAN_METERS = 35.80;
const A320_TAILPLANE_SPAN_METERS = 12.44;
const A320_FUSELAGE_DIAMETER_METERS = 3.95;

// A flat planform in the x/y plane, extruded `thickness` meters along +z.
function planform(outline: [number, number][], thickness: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  return new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
}

// A planform symmetric about the y axis, given its right half from root leading edge to root trailing edge.
function mirroredPlanform(rightHalf: [number, number][], thickness: number): THREE.ExtrudeGeometry {
  const leftHalf = rightHalf.map(([x, y]): [number, number] => [-x, y]).reverse();
  return planform([...rightHalf, ...leftHalf.slice(1, -1)], thickness);
}

// Builds an A300-600 at true scale in meters, nose along +y, up along +z, centered on its length.
function buildPlaneModel(): THREE.Group {
  const body = new THREE.MeshLambertMaterial({ color: 0xf4f4f4, side: THREE.DoubleSide });
  const accent = new THREE.MeshLambertMaterial({ color: 0x1f6feb, side: THREE.DoubleSide });

  const part = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.frustumCulled = false;
    return mesh;
  };

  const radius = A320_FUSELAGE_DIAMETER_METERS / 2;
  const noseY = A320_LENGTH_METERS / 2;
  const tailY = -A320_LENGTH_METERS / 2;
  const noseLength = 6;
  const tailConeLength = 7;
  const cabinLength = A320_LENGTH_METERS - noseLength - tailConeLength;
  const cabinCenterY = tailY + tailConeLength + cabinLength / 2;

  const halfSpan = A320_WINGSPAN_METERS / 2;
  // 28° leading-edge sweep.
  const wingSweep = Math.tan(THREE.MathUtils.degToRad(28)) * halfSpan;
  const wing = mirroredPlanform(
    [[0, 4], [halfSpan, 4 - wingSweep], [halfSpan, 1.5 - wingSweep], [0, -6]],
    0.6,
  );

  const halfTailSpan = A320_TAILPLANE_SPAN_METERS / 2;
  const tailSweep = Math.tan(THREE.MathUtils.degToRad(32)) * halfTailSpan;
  const tailplane = mirroredPlanform(
    [[0, -19], [halfTailSpan, -19 - tailSweep], [halfTailSpan, -21 - tailSweep], [0, -24]],
    0.4,
  );

  // Fin outline in (y, z), rotated so its extrusion runs along x.
  const fin = planform([[-17, 0], [-24.5, 8], [-27, 8], [-26, 0]], 0.5)
    .applyMatrix4(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
    ));

  const tailCone = new THREE.ConeGeometry(radius, tailConeLength, 24).rotateZ(Math.PI);
  const engineX = 9.3;
  const engineGeometry = () => new THREE.CylinderGeometry(1.35, 1.2, 7, 16);

  const plane = new THREE.Group();
  plane.add(
    part(new THREE.CylinderGeometry(radius, radius, cabinLength, 24), body, 0, cabinCenterY, 0),
    part(new THREE.ConeGeometry(radius, noseLength, 24), body, 0, noseY - noseLength / 2, 0),
    part(tailCone, body, 0, tailY + tailConeLength / 2, 0),
    part(wing, body, 0, 0, -radius * 0.6),
    part(engineGeometry(), body, engineX, 2, -radius * 0.6 - 1.6),
    part(engineGeometry(), body, -engineX, 2, -radius * 0.6 - 1.6),
    part(tailplane, accent, 0, 0, 0.3),
    part(fin, accent, -0.25, 0, radius * 0.7),
  );
  return plane;
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

// Mapbox custom layer that renders a 3D plane at the latest position passed to `setPosition`,
// with a trail through its previous positions and a faint vertical line down to the ground.
export class PlaneLayer implements mapboxgl.CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom';
  readonly renderingMode = '3d';

  // The scene uses a local frame in meters centered on `origin`: x east, y north, z up.
  private readonly origin: mapboxgl.MercatorCoordinate;
  private readonly sceneToMercator: THREE.Matrix4;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly plane = buildPlaneModel();
  private readonly trail = new FadingTrail({ color: TRAIL_COLOR, linewidth: 2, maxPoints: MAX_TRAIL_POINTS });
  private readonly dropLineMaterial = new LineMaterial({
    color: DROP_LINE_COLOR,
    linewidth: 1,
    transparent: true,
    opacity: 0.35,
  });
  // A 1 m vertical segment, stretched to the plane's altitude in setPosition.
  private readonly dropLine = new Line2(new LineGeometry().setPositions([0, 0, 0, 0, 0, 1]), this.dropLineMaterial);
  private trailPoints: THREE.Vector3[] = [];
  private lastTrailHeadingDegrees = 0;
  private position: FlightPosition | null = null;
  private map: mapboxgl.Map | null = null;
  private renderer: THREE.WebGLRenderer | null = null;

  constructor(id: string, origin: [number, number]) {
    this.id = id;
    this.origin = mapboxgl.MercatorCoordinate.fromLngLat(origin);
    const metersToMercator = this.origin.meterInMercatorCoordinateUnits();
    // Mercator y grows southward, so north is flipped.
    this.sceneToMercator = new THREE.Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, 0)
      .scale(new THREE.Vector3(metersToMercator, -metersToMercator, metersToMercator));

    this.dropLine.frustumCulled = false;
    this.dropLine.visible = false;
    this.plane.visible = false;

    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(0.5, -1, 2);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5), sun, this.plane, this.trail, this.dropLine);
  }

  setPosition(position: FlightPosition) {
    this.position = position;
    const point = this.toScene(position);

    this.plane.position.copy(point);
    this.plane.rotation.z = -THREE.MathUtils.degToRad(position.headingDegrees);
    this.plane.visible = true;

    this.dropLine.position.set(point.x, point.y, 0);
    this.dropLine.scale.z = Math.max(point.z, 0.01);
    this.dropLine.visible = point.z > 0;

    const last = this.trailPoints.at(-1);
    if (!last || last.distanceTo(point) >= TRAIL_MIN_SPACING_METERS) {
      this.trailPoints.push(...this.trailPointsTo(point, position.headingDegrees));
      this.trailPoints.splice(0, this.trailPoints.length - MAX_TRAIL_POINTS);
      this.lastTrailHeadingDegrees = position.headingDegrees;
      this.trail.setPoints(this.trailPoints);
    }

    this.map?.triggerRepaint();
  }

  onAdd(map: mapboxgl.Map, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  }

  onRemove() {
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof Line2) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  render(gl: WebGL2RenderingContext, matrix: number[]) {
    if (!this.renderer || !this.map || !this.position) {
      return;
    }

    this.plane.scale.setScalar(this.planeScale(this.map.getZoom(), this.position.lat));
    this.trail.setResolution(gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.dropLineMaterial.resolution.set(gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.camera.projectionMatrix.fromArray(matrix).multiply(this.sceneToMercator);

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  // New trail points ending at `point`, spaced about TRAIL_MIN_SPACING_METERS apart along a curve
  // from the last trail point. Fills gaps, such as while the page is hidden and no frames run,
  // with a path that matches the heading at both ends. Returns at most MAX_TRAIL_POINTS points.
  private trailPointsTo(point: THREE.Vector3, headingDegrees: number): THREE.Vector3[] {
    const last = this.trailPoints.at(-1);
    if (!last) {
      return [point];
    }

    const curve = trailCurve(last, this.lastTrailHeadingDegrees, point, headingDegrees);
    const divisions = Math.max(1, Math.floor(curve.getLength() / TRAIL_MIN_SPACING_METERS));
    const points: THREE.Vector3[] = [];
    for (let i = Math.max(1, divisions - MAX_TRAIL_POINTS + 1); i < divisions; i++) {
      points.push(curve.getPointAt(i / divisions));
    }
    points.push(point);
    return points;
  }

  private toScene({ lng, lat, altitudeMeters }: FlightPosition): THREE.Vector3 {
    const coordinate = mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], altitudeMeters);
    const mercatorToMeters = 1 / this.origin.meterInMercatorCoordinateUnits();
    return new THREE.Vector3(
      (coordinate.x - this.origin.x) * mercatorToMeters,
      -(coordinate.y - this.origin.y) * mercatorToMeters,
      altitudeMeters,
    );
  }

  private planeScale(zoom: number, lat: number): number {
    const metersPerPixel =
      (EARTH_CIRCUMFERENCE_METERS * Math.cos(THREE.MathUtils.degToRad(lat))) / (MAPBOX_TILE_SIZE * 2 ** zoom);
    return Math.max(1, (MIN_PLANE_LENGTH_PIXELS * metersPerPixel) / A320_LENGTH_METERS);
  }
}
