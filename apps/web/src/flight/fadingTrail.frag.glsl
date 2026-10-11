uniform vec3 color;
uniform float opacity;
uniform float linewidth;

varying float vFade;
varying float vEdgeDistance;

void main() {
  float coverage = clamp(linewidth * 0.5 + 0.5 - abs(vEdgeDistance), 0.0, 1.0);
  gl_FragColor = vec4(color, opacity * vFade * coverage);
  #include <colorspace_fragment>
}
