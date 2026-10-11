import mapboxgl from 'mapbox-gl';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

import { FadingTrail } from './FadingTrail';
import type { FlightPosition } from './types';

const PLANE_LENGTH_METERS = 40;
// The plane is scaled up when zoomed out so it stays at least this long on screen.
const MIN_PLANE_LENGTH_PIXELS = 16;
const TRAIL_MIN_SPACING_METERS = 25;
const MAX_TRAIL_POINTS = 100;
const EARTH_CIRCUMFERENCE_METERS = 40_075_016.686;
const MAPBOX_TILE_SIZE = 512;
const TRAIL_COLOR = '#ff8c1a';
const DROP_LINE_COLOR = '#ffffff';

// Builds a simple airliner from primitives, nose along +y, up along +z, roughly PLANE_LENGTH_METERS long.
function buildPlaneModel(): THREE.Group {
  const body = new THREE.MeshLambertMaterial({ color: 0xf4f4f4, side: THREE.DoubleSide });
  const accent = new THREE.MeshLambertMaterial({ color: 0x1f6feb, side: THREE.DoubleSide });

  const part = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.frustumCulled = false;
    return mesh;
  };

  const plane = new THREE.Group();
  plane.add(
    part(new THREE.CylinderGeometry(2, 2, 34, 16), body, 0, 0, 0),
    part(new THREE.ConeGeometry(2, 5, 16), body, 0, 19.5, 0),
    part(new THREE.BoxGeometry(34, 5, 0.6), body, 0, 2, -0.5),
    part(new THREE.BoxGeometry(12, 3, 0.5), accent, 0, -15, 0.5),
    part(new THREE.BoxGeometry(0.6, 4, 7), accent, 0, -15, 4),
  );
  return plane;
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
      this.trailPoints.push(point);
      if (this.trailPoints.length > MAX_TRAIL_POINTS) {
        this.trailPoints.shift();
      }
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
    return Math.max(1, (MIN_PLANE_LENGTH_PIXELS * metersPerPixel) / PLANE_LENGTH_METERS);
  }
}
