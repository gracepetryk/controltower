import * as THREE from 'three';

import fragmentShader from './fadingTrail.frag.glsl?raw';
import vertexShader from './fadingTrail.vert.glsl?raw';

interface FadingTrailOptions {
  color: THREE.ColorRepresentation;
  // Width in drawing-buffer pixels.
  linewidth: number;
  opacity?: number;
  maxPoints: number;
}

// A screen-space-width polyline that fades from opaque at its newest point to transparent
// at its oldest. A trail of `maxPoints` points reaches full transparency at its first point;
// shorter trails fade proportionally less.
export class FadingTrail extends THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> {
  private readonly maxPoints: number;
  private readonly segmentStarts: THREE.InstancedBufferAttribute;
  private readonly segmentEnds: THREE.InstancedBufferAttribute;
  private readonly fadeStarts: THREE.InstancedBufferAttribute;
  private readonly fadeEnds: THREE.InstancedBufferAttribute;

  constructor({ color, linewidth, opacity = 1, maxPoints }: FadingTrailOptions) {
    const maxSegments = maxPoints - 1;
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
    this.maxPoints = maxPoints;

    const instanced = (itemSize: number) =>
      new THREE.InstancedBufferAttribute(new Float32Array(maxSegments * itemSize), itemSize).setUsage(
        THREE.DynamicDrawUsage,
      );
    this.segmentStarts = instanced(3);
    this.segmentEnds = instanced(3);
    this.fadeStarts = instanced(1);
    this.fadeEnds = instanced(1);
    geometry.setAttribute('segmentStart', this.segmentStarts);
    geometry.setAttribute('segmentEnd', this.segmentEnds);
    geometry.setAttribute('fadeStart', this.fadeStarts);
    geometry.setAttribute('fadeEnd', this.fadeEnds);
    geometry.instanceCount = 0;
  }

  // Points are ordered oldest first. Throws if there are more than `maxPoints`.
  setPoints(points: THREE.Vector3[]) {
    if (points.length > this.maxPoints) {
      throw new Error(`FadingTrail holds at most ${this.maxPoints} points, got ${points.length}`);
    }

    const fade = (index: number) => 1 - (points.length - 1 - index) / (this.maxPoints - 1);
    for (let i = 0; i < points.length - 1; i++) {
      this.segmentStarts.setXYZ(i, points[i].x, points[i].y, points[i].z);
      this.segmentEnds.setXYZ(i, points[i + 1].x, points[i + 1].y, points[i + 1].z);
      this.fadeStarts.setX(i, fade(i));
      this.fadeEnds.setX(i, fade(i + 1));
    }
    for (const attribute of [this.segmentStarts, this.segmentEnds, this.fadeStarts, this.fadeEnds]) {
      attribute.needsUpdate = true;
    }
    this.geometry.instanceCount = Math.max(points.length - 1, 0);
  }

  setResolution(width: number, height: number) {
    this.material.uniforms.resolution.value.set(width, height);
  }
}
