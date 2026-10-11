// The base quad's x is -1 or 1 for the side of the line; y is 0 at the segment start and 1 at its end.
attribute vec3 segmentStart;
attribute vec3 segmentEnd;
attribute float fadeStart;
attribute float fadeEnd;

uniform vec2 resolution;
uniform float linewidth;

varying float vFade;
varying float vEdgeDistance;

// Signed clip-space distance from the near plane (z = -w); negative means the point is behind it.
float nearPlaneDistance(vec4 clip) {
  return clip.z + clip.w;
}

// Moves a point that is behind the near plane along the segment to where the segment crosses it,
// keeping the perspective divide finite.
vec4 trimToNearPlane(vec4 point, vec4 other) {
  float pointDistance = nearPlaneDistance(point);
  if (pointDistance >= 0.0) {
    return point;
  }
  return mix(point, other, pointDistance / (pointDistance - nearPlaneDistance(other)));
}

void main() {
  mat4 toClip = projectionMatrix * modelViewMatrix;
  vec4 clipStart = toClip * vec4(segmentStart, 1.0);
  vec4 clipEnd = toClip * vec4(segmentEnd, 1.0);

  bool isUnused = fadeStart <= 0.0 && fadeEnd <= 0.0;
  if (isUnused || (nearPlaneDistance(clipStart) < 0.0 && nearPlaneDistance(clipEnd) < 0.0)) {
    // Unused or entirely behind the near plane: place the vertex outside the clip volume.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec4 trimmedStart = trimToNearPlane(clipStart, clipEnd);
  clipEnd = trimToNearPlane(clipEnd, clipStart);
  clipStart = trimmedStart;

  vec2 screenDirection = clipEnd.xy / clipEnd.w * resolution - clipStart.xy / clipStart.w * resolution;
  screenDirection = length(screenDirection) > 1e-6 ? normalize(screenDirection) : vec2(1.0, 0.0);
  vec2 normal = vec2(-screenDirection.y, screenDirection.x);

  // One pixel wider than the line on each side, leaving room to antialias the edge in the fragment shader.
  float halfWidth = linewidth * 0.5 + 1.0;
  float edgeDistance = position.x * halfWidth;

  bool isEnd = position.y > 0.5;
  vec4 clip = isEnd ? clipEnd : clipStart;
  clip.xy += normal * edgeDistance * 2.0 / resolution * clip.w;

  vFade = isEnd ? fadeEnd : fadeStart;
  vEdgeDistance = edgeDistance;
  gl_Position = clip;
}
