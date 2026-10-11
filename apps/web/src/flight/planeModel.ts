import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Airbus A320-200 dimensions.
export const A320_LENGTH_METERS = 37.57;
const A320_WINGSPAN_METERS = 35.80;
const A320_TAILPLANE_SPAN_METERS = 12.44;
const A320_FUSELAGE_DIAMETER_METERS = 3.95;

const BODY_COLOR = new THREE.Color(0xf4f4f4);
const ACCENT_COLOR = new THREE.Color(0x1f6feb);

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

// Moves `geometry` to (x, y, z) and paints it `color`, as a non-indexed geometry ready to merge.
function part(geometry: THREE.BufferGeometry, color: THREE.Color, x: number, y: number, z: number) {
  const placed = (geometry.index ? geometry.toNonIndexed() : geometry).translate(x, y, z);
  const colors = new Float32Array(placed.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) {
    color.toArray(colors, i);
  }
  placed.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  placed.clearGroups();
  return placed;
}

// Builds an A320-200 at true scale in meters, nose along +y, up along +z, centered on its length.
// Parts are merged into one geometry with per-vertex colors so many planes can share one draw call.
export function buildPlaneGeometry(): THREE.BufferGeometry {
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

  const merged = mergeGeometries([
    part(new THREE.CylinderGeometry(radius, radius, cabinLength, 24), BODY_COLOR, 0, cabinCenterY, 0),
    part(new THREE.ConeGeometry(radius, noseLength, 24), BODY_COLOR, 0, noseY - noseLength / 2, 0),
    part(tailCone, BODY_COLOR, 0, tailY + tailConeLength / 2, 0),
    part(wing, BODY_COLOR, 0, 0, -radius * 0.6),
    part(engineGeometry(), BODY_COLOR, engineX, 2, -radius * 0.6 - 1.6),
    part(engineGeometry(), BODY_COLOR, -engineX, 2, -radius * 0.6 - 1.6),
    part(tailplane, ACCENT_COLOR, 0, 0, 0.3),
    part(fin, ACCENT_COLOR, -0.25, 0, radius * 0.7),
  ]);
  if (!merged) {
    throw new Error('Plane model parts have mismatched attributes and could not be merged');
  }
  return merged;
}
