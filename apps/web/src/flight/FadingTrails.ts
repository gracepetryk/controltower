import * as THREE from 'three';

import fragmentShader from './fadingTrail.frag.glsl?raw';
import vertexShader from './fadingTrail.vert.glsl?raw';

interface FadingTrailsOptions {
  color: THREE.ColorRepresentation;
  // Width in drawing-buffer pixels.
  linewidth: number;
  opacity?: number;
  maxTrails: number;
  maxPoints: number;
}

// Up to `maxTrails` independent screen-space-width polylines, drawn in one call. Each trail
// occupies a fixed slot and fades from opaque at its newest point to transparent at its oldest.
// A trail of `maxPoints` points reaches full transparency at its first point; shorter trails
// fade proportionally less.
export class FadingTrails extends THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> {
  private readonly maxTrails: number;
  private readonly maxPoints: number;
  private readonly segmentsPerTrail: number;
  private readonly segmentStarts: THREE.InstancedBufferAttribute;
  private readonly segmentEnds: THREE.InstancedBufferAttribute;
  private readonly fadeStarts: THREE.InstancedBufferAttribute;
  private readonly fadeEnds: THREE.InstancedBufferAttribute;

  constructor({ color, linewidth, opacity = 1, maxTrails, maxPoints }: FadingTrailsOptions) {
    const segmentsPerTrail = maxPoints - 1;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3),
    );
    geometry.setIndex([0, 1, 2, 2, 1, 3]);

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        color: { value: new THREE.Color(color) },
        opacity: { value: opacity },
        linewidth: { value: linewidth },
        resolution: { value: new THREE.Vector2(1, 1) },
      },
      transparent: true,
      depthWrite: false,
      // The ribbon is built in screen space, so its winding depends on segment direction, not facing.
      side: THREE.DoubleSide,
    });

    super(geometry, material);
    this.frustumCulled = false;
    this.maxTrails = maxTrails;
    this.maxPoints = maxPoints;
    this.segmentsPerTrail = segmentsPerTrail;

    // Unused segments have zero fade, which the vertex shader skips.
    const instanced = (itemSize: number) =>
      new THREE.InstancedBufferAttribute(
        new Float32Array(maxTrails * segmentsPerTrail * itemSize),
        itemSize,
      ).setUsage(THREE.DynamicDrawUsage);
    this.segmentStarts = instanced(3);
    this.segmentEnds = instanced(3);
    this.fadeStarts = instanced(1);
    this.fadeEnds = instanced(1);
    geometry.setAttribute('segmentStart', this.segmentStarts);
    geometry.setAttribute('segmentEnd', this.segmentEnds);
    geometry.setAttribute('fadeStart', this.fadeStarts);
    geometry.setAttribute('fadeEnd', this.fadeEnds);
    geometry.instanceCount = maxTrails * segmentsPerTrail;
  }

  // Replaces the trail in `slot` with `points`, ordered oldest first. Throws if `slot` is out of
  // range or there are more than `maxPoints` points.
  setTrail(slot: number, points: THREE.Vector3[]) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.maxTrails) {
      throw new Error(`FadingTrails slot must be an integer in [0, ${this.maxTrails}), got ${slot}`);
    }
    if (points.length > this.maxPoints) {
      throw new Error(`FadingTrails holds at most ${this.maxPoints} points per trail, got ${points.length}`);
    }

    const first = slot * this.segmentsPerTrail;
    const fade = (index: number) => 1 - (points.length - 1 - index) / (this.maxPoints - 1);
    for (let i = 0; i < this.segmentsPerTrail; i++) {
      const segment = first + i;
      if (i < points.length - 1) {
        this.segmentStarts.setXYZ(segment, points[i].x, points[i].y, points[i].z);
        this.segmentEnds.setXYZ(segment, points[i + 1].x, points[i + 1].y, points[i + 1].z);
        this.fadeStarts.setX(segment, fade(i));
        this.fadeEnds.setX(segment, fade(i + 1));
      } else {
        this.fadeStarts.setX(segment, 0);
        this.fadeEnds.setX(segment, 0);
      }
    }
    for (const attribute of [this.segmentStarts, this.segmentEnds, this.fadeStarts, this.fadeEnds]) {
      attribute.addUpdateRange(first * attribute.itemSize, this.segmentsPerTrail * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  clearTrail(slot: number) {
    this.setTrail(slot, []);
  }

  setResolution(width: number, height: number) {
    this.material.uniforms.resolution.value.set(width, height);
  }
}
