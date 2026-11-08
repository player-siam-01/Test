// Track geometry + spatial queries. Pure logic (no rendering) so it can run
// headless in tests and inside the fixed-step simulation.
import * as THREE from 'three';

export const ROAD_HALF = 8;     // half width of asphalt (m)
export const CURB_WIDTH = 1.4;  // red/white curb strip outside the asphalt
export const WALL_DIST = 14;    // distance from centerline to barrier

// Closed circuit control points (x, z) in metres. Index 0 is the start line.
const CONTROL = [
  [0, -100], [0, 150], [40, 235], [130, 255], [205, 205], [195, 120],
  [135, 85], [120, 25], [185, -30], [250, -100], [225, -200], [135, -235],
  [60, -262], [12, -235], [0, -180],
];

export function createTrack(N = 1200) {
  const pts = CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  const length = curve.getLength();
  const spaced = curve.getSpacedPoints(N);
  const ds = length / N;

  const px = new Float32Array(N), pz = new Float32Array(N);
  const tx = new Float32Array(N), tz = new Float32Array(N);
  const sx = new Float32Array(N), sz = new Float32Array(N);
  const curv = new Float32Array(N);

  for (let i = 0; i < N; i++) { px[i] = spaced[i].x; pz[i] = spaced[i].z; }
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N, b = (i + 1) % N;
    let dx = px[b] - px[a], dz = pz[b] - pz[a];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    tx[i] = dx; tz[i] = dz;
    // "side" = right-hand side when driving along the tangent (y up)
    sx[i] = -dz; sz[i] = dx;
  }
  // signed curvature over a small window (rad / m)
  const K = 4;
  for (let i = 0; i < N; i++) {
    const a = (i - K + N) % N, b = (i + K) % N;
    const h0 = Math.atan2(tx[a], tz[a]), h1 = Math.atan2(tx[b], tz[b]);
    let d = h1 - h0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    curv[i] = d / (2 * K * ds);
  }
  return { N, length, ds, px, pz, tx, tz, sx, sz, curv, curve };
}

export const wrap = (i, N) => ((i % N) + N) % N;

/** Exhaustive nearest sample search. */
export function nearestIndex(track, x, z) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < track.N; i++) {
    const dx = x - track.px[i], dz = z - track.pz[i];
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/**
 * Locate a world position relative to the track, searching a window around a
 * hint index. Returns sample index, fractional index, and lateral offset
 * (positive = right of centre when driving forward).
 */
export function locate(track, x, z, hint) {
  const { N, px, pz } = track;
  let best = hint, bd = Infinity;
  if (hint == null || hint < 0) {
    best = nearestIndex(track, x, z);
  } else {
    for (let k = -30; k <= 50; k++) {
      const i = wrap(hint + k, N);
      const dx = x - px[i], dz = z - pz[i];
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
  }
  const dx = x - px[best], dz = z - pz[best];
  const along = dx * track.tx[best] + dz * track.tz[best];
  const lat = dx * track.sx[best] + dz * track.sz[best];
  return { i: best, f: best + along / track.ds, lat };
}

/** Point on the track at a (fractional) index with lateral offset. */
export function pointAt(track, fi, lat = 0) {
  const { N } = track;
  const i0 = Math.floor(fi), t = fi - i0;
  const a = wrap(i0, N), b = wrap(i0 + 1, N);
  const x = track.px[a] + (track.px[b] - track.px[a]) * t;
  const z = track.pz[a] + (track.pz[b] - track.pz[a]) * t;
  return { x: x + track.sx[a] * lat, z: z + track.sz[a] * lat, heading: Math.atan2(track.tx[a], track.tz[a]) };
}
