// High-detail procedural textures: tileable fractal noise -> colour, normal
// and roughness maps. No image files needed.
import * as THREE from 'three';

function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Tileable fBm heightfield in [0,1], size x size. */
export function fbm(size, { octaves = 5, base = 8, seed = 1, gain = 0.5 } = {}) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const period = base << o;
    const cell = size / period;
    for (let y = 0; y < size; y++) {
      const fy = y / cell, y0 = Math.floor(fy), ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const ya = y0 % period, yb = (y0 + 1) % period;
      for (let x = 0; x < size; x++) {
        const fx = x / cell, x0 = Math.floor(fx), tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const xa = x0 % period, xb = (x0 + 1) % period;
        const a = hash(xa, ya, seed + o), b = hash(xb, ya, seed + o);
        const c = hash(xa, yb, seed + o), d = hash(xb, yb, seed + o);
        out[y * size + x] += amp * (a + (b - a) * sx + (c - a + (a - b - c + d) * sx) * sy);
      }
    }
    total += amp; amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function toTexture(canvas, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function canvasFrom(size, fill) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  fill(img.data);
  g.putImageData(img, 0, 0);
  return { c, g };
}

/** Normal map from a heightfield (tileable). */
export function normalMap(h, size, strength = 2) {
  const { c } = canvasFrom(size, (d) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)], r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x], dn = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength, ny = (u - dn) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
  });
  return toTexture(c, false);
}

/**
 * Asphalt: aggregate grain + large dark patches; roughness map makes the
 * patches slightly glossy so lamp light glints off the road.
 */
export function asphaltMaps(size = 1024) {
  const grain = fbm(size, { octaves: 3, base: 256, seed: 11, gain: 0.55 });
  const patches = fbm(size, { octaves: 4, base: 3, seed: 5 });
  const height = new Float32Array(size * size);
  const { c, g } = canvasFrom(size, (d) => {
    for (let i = 0; i < size * size; i++) {
      const p = Math.max(0, Math.min(1, (patches[i] - 0.38) * 2.2));
      const gr = grain[i];
      const speck = gr > 0.74 ? (gr - 0.74) * 160 : 0;
      const v = 58 + gr * 18 - p * 12 + speck;
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v + 3; d[i * 4 + 3] = 255;
      height[i] = gr;
    }
  });
  // racing-line rubber and lane markings
  const gr2 = g.createLinearGradient(0, 0, size, 0);
  gr2.addColorStop(0.2, 'rgba(0,0,0,0)'); gr2.addColorStop(0.38, 'rgba(10,10,12,0.32)');
  gr2.addColorStop(0.62, 'rgba(10,10,12,0.32)'); gr2.addColorStop(0.8, 'rgba(0,0,0,0)');
  g.fillStyle = gr2; g.fillRect(0, 0, size, size);
  g.globalAlpha = 0.92;
  g.fillStyle = '#ecebe6';
  g.fillRect(size * 0.03, 0, size * 0.022, size);
  g.fillRect(size * 0.948, 0, size * 0.022, size);
  g.fillStyle = '#f0c02a';
  g.fillRect(size * 0.493, 0, size * 0.014, size * 0.42);
  g.globalAlpha = 1;
  const rough = canvasFrom(size, (d) => {
    for (let i = 0; i < size * size; i++) {
      const p = Math.max(0, Math.min(1, (patches[i] - 0.4) * 2.5));
      const v = 235 - p * 120 - grain[i] * 20;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
  }).c;
  return { map: toTexture(c, true), normalMap: normalMap(height, size, 1.6), roughnessMap: toTexture(rough, false) };
}

export function grassMaps(size = 512) {
  const fine = fbm(size, { octaves: 3, base: 64, seed: 21, gain: 0.65 });
  const broad = fbm(size, { octaves: 4, base: 2, seed: 7 });
  const { c } = canvasFrom(size, (d) => {
    for (let i = 0; i < size * size; i++) {
      const f = fine[i], b = broad[i];
      d[i * 4] = 26 + f * 16 + b * 22;
      d[i * 4 + 1] = 58 + f * 30 + b * 26;
      d[i * 4 + 2] = 26 + f * 18;
      d[i * 4 + 3] = 255;
    }
  });
  return { map: toTexture(c, true), normalMap: normalMap(fine, size, 1.5) };
}

export function concreteMaps(size = 256) {
  const n = fbm(size, { octaves: 5, base: 8, seed: 31 });
  const { c, g } = canvasFrom(size, (d) => {
    for (let i = 0; i < size * size; i++) {
      const v = 120 + n[i] * 70;
      d[i * 4] = v; d[i * 4 + 1] = v * 0.98; d[i * 4 + 2] = v * 0.96; d[i * 4 + 3] = 255;
    }
  });
  // segment joints
  g.fillStyle = 'rgba(20,20,20,0.6)';
  g.fillRect(0, 0, 3, size);
  return { map: toTexture(c, true), normalMap: normalMap(n, size, 2) };
}
