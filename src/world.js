// Builds the 3D environment: a realistic daytime circuit lit by a real HDR sky.
// Photo textures (CC0, Poly Haven) are loaded from /assets; see assets/CREDITS.md.
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { ROAD_HALF, CURB_WIDTH, WALL_DIST, nearestIndex } from './track.js';
import { fbm } from './textures.js';

export function canvasTexture(w, h, draw, { repeat = [1, 1], srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function radialTexture(stops) {
  return canvasTexture(128, 128, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    for (const [o, c] of stops) gr.addColorStop(o, c);
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
}

function rng(seed) {
  let s = seed % 2147483647; if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * Horizontal strip following the track between lateral offsets a..b, over the
 * sample runs given (default: the whole loop). u spans a..b in metres / uLen,
 * v runs along the track in metres / vLen.
 */
function ribbon(track, a, b, y, { vLen = 10, uLen = null, runs = null } = {}) {
  const { N, px, pz, sx, sz, ds } = track;
  const pos = [], uv = [], idx = [];
  const uMax = uLen ? Math.abs(b - a) / uLen : 1;
  for (const [i0, i1] of runs || [[0, N]]) {
    const base = pos.length / 3;
    for (let k = i0; k <= i1; k++) {
      const i = ((k % N) + N) % N;
      const v = (k * ds) / vLen;
      pos.push(px[i] + sx[i] * a, y, pz[i] + sz[i] * a, px[i] + sx[i] * b, y, pz[i] + sz[i] * b);
      uv.push(0, v, uMax, v);
      if (k < i1) { const o = base + (k - i0) * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Vertical strip at lateral offset d from y0..y1 (u = metres along / uLen, v = 0..1). */
function wallRibbon(track, d, y0, y1, { uLen = 1, runs = null } = {}) {
  const { N, px, pz, sx, sz, ds } = track;
  const pos = [], uv = [], idx = [];
  for (const [i0, i1] of runs || [[0, N]]) {
    const base = pos.length / 3;
    for (let k = i0; k <= i1; k++) {
      const i = ((k % N) + N) % N;
      const x = px[i] + sx[i] * d, z = pz[i] + sz[i] * d;
      const u = (k * ds) / uLen;
      pos.push(x, y0, z, x, y1, z);
      uv.push(u, 0, u, 1);
      if (k < i1) { const o = base + (k - i0) * 2; idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function mergeGeometries(geoms) {
  const pos = [], nor = [], uv = [];
  for (const g0 of geoms) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    for (const v of g.attributes.position.array) pos.push(v);
    for (const v of g.attributes.normal.array) nor.push(v);
    for (const v of g.attributes.uv.array) uv.push(v);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return out;
}

/** Runs of track samples on the outside of corners (for gravel traps / catch fences). */
function cornerRuns(track, side, minCurv = 1 / 90, pad = 40) {
  const { N, curv } = track;
  const hot = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (Math.abs(curv[i]) > minCurv && Math.sign(curv[i]) === side) {
      for (let k = -pad; k <= pad; k++) hot[((i + k) % N + N) % N] = 1;
    }
  }
  const runs = [];
  let start = -1;
  for (let i = 0; i <= N; i++) {
    const on = i < N && hot[i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) { runs.push([start, i - 1]); start = -1; }
  }
  // merge a run that wraps past the start line
  if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === N - 1) {
    const last = runs.pop(); runs[0] = [last[0] - N, runs[0][1]];
  }
  return runs;
}

/**
 * A fir tree built the way games build them: a textured trunk plus ~60 photo
 * "branch cards" (alpha-tested quads) arranged in drooping tiers.
 */
function firGeometry(R) {
  const trunk = new THREE.CylinderGeometry(0.12, 0.32, 12, 7, 1, true).translate(0, 6, 0);
  const uvT = trunk.attributes.uv;
  for (let k = 0; k < uvT.count; k++) uvT.setXY(k, uvT.getX(k) * 2, uvT.getY(k) * 6);
  // two branch sprites cut from the atlas (u0,u1,v0 = stem end, v1 = tip)
  const sprites = [[0.31, 0.64, 0.22, 0.6], [0.645, 0.947, 0.17, 0.541]];
  const cards = [];
  const m = new THREE.Matrix4(), tmp = new THREE.Matrix4();
  const H = 12.5, tiers = 16;
  for (let t = 0; t < tiers; t++) {
    const h = 1.2 + (t / tiers) * (H - 1.8);
    const frac = 1 - (h - 1.2) / (H - 1.2);
    const L = 0.7 + 3.0 * frac;
    const n = Math.max(5, Math.round(6 + frac * 6));
    for (let b = 0; b < n; b++) {
      const [u0, u1, v0, v1] = sprites[(t + b) % 2];
      const w = L * 1.25;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-w / 2, 0, 0, w / 2, 0, 0, -w / 2, 0, L, w / 2, 0, L], 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u0, v1, u1, v1], 2));
      g.setIndex([0, 2, 1, 1, 2, 3]);
      const roll = (R() - 0.5) * 2.2, droop = 0.2 + R() * 0.4;
      const az = (b / n) * Math.PI * 2 + t * 0.7 + R() * 0.4;
      m.makeTranslation(0, h, 0)
        .multiply(tmp.makeRotationY(az))
        .multiply(tmp.makeRotationX(droop))
        .multiply(tmp.makeRotationZ(roll));
      g.applyMatrix4(m);
      cards.push(g);
    }
  }
  // crown: two crossed vertical cards
  for (const az of [0, Math.PI / 2]) {
    const g = new THREE.PlaneGeometry(1.4, 2.2);
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, 0.31 + uv.getX(k) * 0.33, 0.22 + uv.getY(k) * 0.38);
    g.rotateY(az).translate(0, H - 0.6, 0);
    cards.push(g);
  }
  return { trunk, foliage: mergeGeometries(cards) };
}

export function buildWorld(scene, renderer, track) {
  const R = rng(1337);
  const manager = new THREE.LoadingManager();
  const loader = new THREE.TextureLoader(manager);
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tex = (name, { srgb = true, repeat = [1, 1] } = {}) => {
    const t = loader.load(`./assets/${name}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.anisotropy = maxAniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  // ------------------------------------------------------------ sky + light
  const sky = tex('sky.webp');
  sky.wrapT = THREE.ClampToEdgeWrapping;
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;
  scene.backgroundIntensity = 1.0;
  scene.fog = new THREE.Fog(0xbfcbd8, 300, 2600);

  const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x4a5a3a, 0.35);
  scene.add(hemi);
  const sunDir = new THREE.Vector3(0.45, 0.62, 0.64).normalize();
  const sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 450;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);

  // Real HDR lighting + reflections; the sun light is aimed at the HDR's sun
  const pmrem = new THREE.PMREMGenerator(renderer);
  // (the .hdr is shipped base64-encoded inside JSON so any static host will serve it)
  manager.itemStart('sky-hdr');
  const hdrReady = fetch('./assets/sky_1k.hdr.json').then((r) => r.json()).then(({ base64 }) => {
    const bin = atob(base64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes]));
    return new RGBELoader().setDataType(THREE.FloatType).loadAsync(url).finally(() => URL.revokeObjectURL(url));
  }).then((hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const { data, width, height } = hdr.image;
    let best = 0, bi = 0;
    for (let i = 0; i < width * height; i++) {
      const l = data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722;
      if (l > best) { best = l; bi = i; }
    }
    const x = bi % width, y = Math.floor(bi / width);
    const u = (x + 0.5) / width, v = 1 - (y + 0.5) / height;
    const lat = (v - 0.5) * Math.PI, lon = (u - 0.5) * Math.PI * 2;
    sunDir.set(Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat)).normalize();
    scene.environment = pmrem.fromEquirectangular(hdr).texture;
    scene.environmentIntensity = 1.0;
    hdr.dispose(); pmrem.dispose();
    manager.itemEnd('sky-hdr');
  });

  // ------------------------------------------------------------ ground
  // grass with a large-scale tint map in world space, so the tiling disappears
  const grassMap = tex('grass_diff.webp', { repeat: [1, 1] });
  const grassNor = tex('grass_nor.webp', { srgb: false });
  const macroSize = 256;
  const macroData = fbm(macroSize, { octaves: 4, base: 4, seed: 99 });
  const macroImg = new Uint8Array(macroSize * macroSize * 4);
  for (let i = 0; i < macroData.length; i++) {
    const v = Math.round(macroData[i] * 255);
    macroImg[i * 4] = macroImg[i * 4 + 1] = macroImg[i * 4 + 2] = v; macroImg[i * 4 + 3] = 255;
  }
  const macroTex = new THREE.DataTexture(macroImg, macroSize, macroSize);
  macroTex.wrapS = macroTex.wrapT = THREE.RepeatWrapping; macroTex.magFilter = THREE.LinearFilter;
  macroTex.minFilter = THREE.LinearMipmapLinearFilter; macroTex.generateMipmaps = true; macroTex.needsUpdate = true;
  const withMacro = (mat, scale, lo, hi, tileMetres) => {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.macroMap = { value: macroTex };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWorldXZ;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D macroMap;\nvarying vec2 vWorldXZ;')
        .replace('#include <map_fragment>', `#ifdef USE_MAP
          vec4 texelA = texture2D(map, vWorldXZ / ${tileMetres.toFixed(1)});
          vec4 texelB = texture2D(map, vWorldXZ / ${(tileMetres * 3.7).toFixed(1)} + 0.37);
          float mm = texture2D(macroMap, vWorldXZ / ${scale.toFixed(1)}).r;
          diffuseColor *= mix(texelA, texelB, smoothstep(0.35, 0.65, mm) * 0.6);
          diffuseColor.rgb *= mix(${lo.toFixed(2)}, ${hi.toFixed(2)}, mm);
        #endif`);
    };
    mat.customProgramCacheKey = () => `macro-${tileMetres}`;
    return mat;
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000),
    withMacro(new THREE.MeshStandardMaterial({ map: grassMap, normalMap: grassNor, normalScale: new THREE.Vector2(0.6, 0.6),
      color: 0x8cb25e, roughness: 0.95, metalness: 0, envMapIntensity: 0.5 }), 260, 0.7, 1.05, 3.0));
  ground.rotation.x = -Math.PI / 2;
  // ground UVs drive the normal map; set them in metres / 3
  const gUv = ground.geometry.attributes.uv;
  for (let k = 0; k < gUv.count; k++) gUv.setXY(k, gUv.getX(k) * 2000, gUv.getY(k) * 2000);
  ground.receiveShadow = true;
  scene.add(ground);

  // ------------------------------------------------------------ asphalt
  const roadMat = new THREE.MeshStandardMaterial({
    map: tex('asphalt_diff.webp'), normalMap: tex('asphalt_nor.webp', { srgb: false }),
    roughnessMap: tex('asphalt_rough.webp', { srgb: false }), roughness: 1.0, metalness: 0, envMapIntensity: 0.9,
    normalScale: new THREE.Vector2(0.8, 0.8),
  });
  const road = new THREE.Mesh(ribbon(track, -ROAD_HALF - 0.2, ROAD_HALF + 0.2, 0.02, { vLen: 4, uLen: 4 }), roadMat);
  road.receiveShadow = true;
  scene.add(road);

  // white edge lines
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1 });
  for (const s of [-1, 1]) {
    const a = s * (ROAD_HALF - 0.55), b = s * (ROAD_HALF - 0.3);
    const m = new THREE.Mesh(ribbon(track, Math.min(a, b), Math.max(a, b), 0.03), lineMat);
    m.receiveShadow = true;
    scene.add(m);
  }

  // curbs: painted red/white concrete with a little relief
  const curbTex = canvasTexture(64, 256, (g, w, h) => {
    g.fillStyle = '#c8202c'; g.fillRect(0, 0, w, h / 2);
    g.fillStyle = '#f2f2ee'; g.fillRect(0, h / 2, w, h / 2);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, h / 2 - 3, w, 3); g.fillRect(0, h - 3, w, 3);
  });
  const curbMat = new THREE.MeshStandardMaterial({ map: curbTex, normalMap: tex('concrete_nor.webp', { srgb: false }),
    normalScale: new THREE.Vector2(0.4, 0.4), roughness: 0.65, polygonOffset: true, polygonOffsetFactor: -1 });
  for (const s of [-1, 1]) {
    const a = s * ROAD_HALF, b = s * (ROAD_HALF + CURB_WIDTH);
    const m = new THREE.Mesh(ribbon(track, Math.min(a, b), Math.max(a, b), 0.05, { vLen: 4 }), curbMat);
    m.receiveShadow = true;
    scene.add(m);
  }

  // gravel traps on the outside of corners
  const gravelMat = new THREE.MeshStandardMaterial({ map: tex('gravel_diff.webp'), normalMap: tex('gravel_nor.webp', { srgb: false }),
    roughness: 1, color: 0xd8d0c4, polygonOffset: true, polygonOffsetFactor: -1 });
  for (const s of [-1, 1]) {
    const runs = cornerRuns(track, s);
    if (!runs.length) continue;
    const a = s * (ROAD_HALF + CURB_WIDTH), b = s * (WALL_DIST - 0.1);
    const m = new THREE.Mesh(ribbon(track, Math.min(a, b), Math.max(a, b), 0.03, { vLen: 2.5, uLen: 2.5, runs }), gravelMat);
    m.receiveShadow = true;
    scene.add(m);
  }

  // ------------------------------------------------------------ barriers
  // concrete wall with thickness: inner face, cap and outer face
  const concMap = tex('concrete_diff.webp');
  const concNor = tex('concrete_nor.webp', { srgb: false });
  const wallMat = new THREE.MeshStandardMaterial({ map: concMap, normalMap: concNor, roughness: 0.9, color: 0xe6e3dc });
  const capMat = new THREE.MeshStandardMaterial({ map: concMap, roughness: 0.9, color: 0xd2cfc8 });
  const stripeTex = canvasTexture(256, 32, (g, w, h) => {
    for (let k = 0; k < 4; k++) { g.fillStyle = k % 2 ? '#f0f0ec' : '#c8202c'; g.fillRect(k * w / 4, 0, w / 4, h); }
  });
  const stripeMat = new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1 });
  const WALL_H = 1.05;
  for (const s of [-1, 1]) {
    const d = s * WALL_DIST, back = s * (WALL_DIST + 0.45);
    const inner = new THREE.Mesh(wallRibbon(track, d, 0, WALL_H, { uLen: 1.05 }), wallMat);
    const outer = new THREE.Mesh(wallRibbon(track, back, 0, WALL_H, { uLen: 1.05 }), wallMat);
    const cap = new THREE.Mesh(ribbon(track, Math.min(d, back), Math.max(d, back), WALL_H, { vLen: 1.05 }), capMat);
    for (const m of [inner, outer, cap]) { m.castShadow = m.receiveShadow = true; m.material.side = THREE.DoubleSide; scene.add(m); }
    // red/white painted band on the inner face at corners
    const runs = cornerRuns(track, s, 1 / 90, 20);
    if (runs.length) scene.add(new THREE.Mesh(wallRibbon(track, d - s * 0.01, 0.55, 0.9, { uLen: 4, runs }), stripeMat));
  }

  // catch fences behind the outside of corners (alpha-tested chain-link)
  const fenceTex = canvasTexture(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(190,195,200,1)'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h); g.moveTo(w, 0); g.lineTo(0, h); g.stroke();
  }, { srgb: true });
  fenceTex.repeat.set(1, 6);
  const fenceMat = new THREE.MeshStandardMaterial({ map: fenceTex, alphaTest: 0.5, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a8d92, metalness: 0.85, roughness: 0.35 });
  const postSpots = [];
  for (const s of [-1, 1]) {
    const runs = cornerRuns(track, s, 1 / 90, 30);
    if (!runs.length) continue;
    const d = s * (WALL_DIST + 0.3);
    const f = new THREE.Mesh(wallRibbon(track, d, WALL_H, WALL_H + 3.2, { uLen: 0.25, runs }), fenceMat);
    f.castShadow = true;
    scene.add(f);
    for (const [i0, i1] of runs) for (let k = i0; k <= i1; k += Math.round(4 / track.ds)) postSpots.push([((k % track.N) + track.N) % track.N, d]);
  }
  const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 3.4, 6).translate(0, WALL_H + 1.7, 0), metal, Math.max(1, postSpots.length));
  const m4 = new THREE.Matrix4();
  postSpots.forEach(([i, d], k) => { m4.makeTranslation(track.px[i] + track.sx[i] * d, 0, track.pz[i] + track.sz[i] * d); posts.setMatrixAt(k, m4); });
  posts.castShadow = true;
  scene.add(posts);

  // trackside advertising boards on the straights (fictional brands)
  const BRANDS = [['VOLTRA', '#0b57d0', '#ffffff'], ['NOVA FUEL', '#ffffff', '#d01c1c'], ['HYPERION', '#111111', '#ffcc00'], ['ZENITH TYRES', '#ffcc00', '#111111']];
  const adTex = canvasTexture(1024, 512, (g, w, h) => {
    BRANDS.forEach(([name, bg, fg], k) => {
      const y = k * h / 4;
      g.fillStyle = bg; g.fillRect(0, y, w, h / 4);
      g.fillStyle = fg; g.font = 'italic 900 84px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(name, w / 2, y + h / 8 + 4);
    });
  });
  const adMat = new THREE.MeshStandardMaterial({ map: adTex, roughness: 0.5 });
  const adGeo = new THREE.PlaneGeometry(8, 1.0);
  for (let i = 0, n = 0; i < track.N; i += Math.round(24 / track.ds), n++) {
    if (Math.abs(track.curv[i]) > 1 / 200) continue;
    const s = n % 3 === 0 ? 1 : -1;
    const d = s * (WALL_DIST + 0.5);
    const g = adGeo.clone();
    const brand = n % 4, uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setY(k, (3 - brand) / 4 + uv.getY(k) / 4);
    const board = new THREE.Mesh(g, adMat);
    board.position.set(track.px[i] + track.sx[i] * d, WALL_H + 0.62, track.pz[i] + track.sz[i] * d);
    board.lookAt(track.px[i], WALL_H + 0.62, track.pz[i]);
    board.castShadow = true;
    scene.add(board);
  }

  // ------------------------------------------------------------ start / finish
  const startTex = canvasTexture(256, 32, (g, w, h) => {
    const n = 16;
    for (let y = 0; y < 2; y++) for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? '#151515' : '#f2f2f2';
      g.fillRect(x * w / n, y * h / 2, w / n, h / 2);
    }
  });
  const p0 = { x: track.px[0], z: track.pz[0] };
  const h0 = Math.atan2(track.tx[0], track.tz[0]);
  const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 1.6),
    new THREE.MeshStandardMaterial({ map: startTex, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 }));
  line.rotation.set(-Math.PI / 2, 0, h0);
  line.position.set(p0.x, 0.045, p0.z);
  line.receiveShadow = true;
  scene.add(line);

  const gantry = new THREE.Group();
  gantry.position.set(p0.x, 0, p0.z);
  gantry.rotation.y = h0;
  const steel = new THREE.MeshStandardMaterial({ color: 0x3c3f45, metalness: 0.8, roughness: 0.4 });
  for (const s of [-1, 1]) {
    const pil = new THREE.Mesh(new THREE.BoxGeometry(0.7, 8.2, 0.7), steel);
    pil.position.set(s * (WALL_DIST + 0.9), 4.1, 0); pil.castShadow = true;
    gantry.add(pil);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(WALL_DIST * 2 + 2.6, 1.6, 0.9), steel);
  beam.position.y = 8.6; beam.castShadow = true;
  gantry.add(beam);
  const signTex = canvasTexture(1024, 96, (g, w, h) => {
    g.fillStyle = '#16181c'; g.fillRect(0, 0, w, h);
    g.font = '800 58px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#f4f4f4'; g.fillText('GRAND PRIX  ·  START / FINISH', w / 2, h / 2 + 3);
  });
  for (const s of [-1, 1]) {
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(WALL_DIST * 2, 1.3), new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.6 }));
    sign.position.set(0, 8.6, s * 0.46);
    if (s < 0) sign.rotation.y = Math.PI;
    gantry.add(sign);
  }
  const startLights = [];
  for (let k = 0; k < 3; k++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x220000, toneMapped: false });
    const l = new THREE.Mesh(new THREE.CircleGeometry(0.36, 24), mat);
    l.position.set((k - 1) * 1.2, 7.1, -0.47);
    l.rotation.y = Math.PI;
    const housing = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 0.3), steel);
    housing.position.set((k - 1) * 1.2, 7.1, -0.32);
    gantry.add(housing, l);
    startLights.push(mat);
  }
  scene.add(gantry);

  // corner marker boards (white with red arrows) on the outside of tight corners
  const chevTex = canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = '#f4f4f2'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#c81e1e';
    for (let k = 0; k < 4; k++) {
      const x = 20 + k * 60;
      g.beginPath(); g.moveTo(x, 8); g.lineTo(x + 30, h / 2); g.lineTo(x, h - 8); g.lineTo(x + 16, h - 8);
      g.lineTo(x + 46, h / 2); g.lineTo(x + 16, 8); g.closePath(); g.fill();
    }
  });
  const chevMatA = new THREE.MeshStandardMaterial({ map: chevTex, roughness: 0.6 });
  const chevTexB = chevTex.clone(); chevTexB.repeat.x = -1; chevTexB.needsUpdate = true;
  const chevMatB = new THREE.MeshStandardMaterial({ map: chevTexB, roughness: 0.6 });
  const chevGeo = new THREE.PlaneGeometry(3.2, 0.8);
  for (let i = 0; i < track.N; i += Math.round(22 / track.ds)) {
    if (Math.abs(track.curv[i]) <= 1 / 70) continue;
    const o = Math.sign(track.curv[i]);
    const d = o * (WALL_DIST - 0.06);
    const board = new THREE.Mesh(chevGeo, o < 0 ? chevMatA : chevMatB);
    board.position.set(track.px[i] + track.sx[i] * d, WALL_H + 0.55, track.pz[i] + track.sz[i] * d);
    board.lookAt(track.px[i], WALL_H + 0.55, track.pz[i]);
    board.castShadow = true;
    scene.add(board);
  }

  // ------------------------------------------------------------ grandstand
  const stand = new THREE.Group();
  const standMat = new THREE.MeshStandardMaterial({ map: concMap, normalMap: concNor, roughness: 0.9, color: 0xc9c5bd });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x1d4e89, roughness: 0.6 });
  const crowdMat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const crowdGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.17, 0.21, 0.55, 6, 1, true).translate(0, 0.27, 0),
    new THREE.IcosahedronGeometry(0.2, 0).scale(1.15, 0.45, 0.8).translate(0, 0.52, 0),
    new THREE.IcosahedronGeometry(0.12, 0).translate(0, 0.72, 0),
  ]);
  const rows = 6, perRow = 140;
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, rows * perRow);
  const palette = [0x2a2f45, 0x3b3f52, 0xd9d9de, 0x1d4e89, 0xb81d3a, 0xf2f2f2, 0x22b5d0, 0xe0b020, 0x4a3a5c, 0x5c6b3a, 0xe87a3a];
  let ci = 0;
  for (let r = 0; r < rows; r++) {
    const stepH = 1 + r * 1.2;
    const step = new THREE.Mesh(new THREE.BoxGeometry(3, stepH, 100), standMat);
    step.position.set(-(WALL_DIST + 6 + r * 3), stepH / 2, -95);
    step.castShadow = true; step.receiveShadow = true;
    stand.add(step);
    const seats = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.35, 99), seatMat);
    seats.position.set(-(WALL_DIST + 5.4 + r * 3), stepH + 0.17, -95);
    stand.add(seats);
    for (let k = 0; k < perRow; k++) {
      if (R() < 0.12) { m4.makeScale(0, 0, 0); crowd.setMatrixAt(ci++, m4); continue; } // empty seat
      m4.makeTranslation(-(WALL_DIST + 5.6 + r * 3 + R() * 0.4), stepH + 0.3, -144 + k * 0.7 + R() * 0.12);
      crowd.setMatrixAt(ci, m4);
      crowd.setColorAt(ci, new THREE.Color(palette[Math.floor(R() * palette.length)]));
      ci++;
    }
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(22, 0.4, 104), steel);
  roof.position.set(-(WALL_DIST + 13), 12, -95); roof.castShadow = true;
  stand.add(roof, crowd);
  for (let k = 0; k < 6; k++) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 12, 8), steel);
    col.position.set(-(WALL_DIST + 23), 6, -142 + k * 19.2); col.castShadow = true;
    stand.add(col);
  }
  scene.add(stand);
  const crowdAnim = { mesh: crowd, base: [] };
  for (let k = 0; k < crowd.count; k++) { crowd.getMatrixAt(k, m4); crowdAnim.base.push(new THREE.Vector3().setFromMatrixPosition(m4)); }

  // ------------------------------------------------------------ trees
  const fir = firGeometry(R);
  const twig = tex('fir_twig.webp');
  twig.wrapS = twig.wrapT = THREE.ClampToEdgeWrapping;
  const barkMat = new THREE.MeshStandardMaterial({ map: tex('bark_diff.webp'), normalMap: tex('bark_nor.webp', { srgb: false }), roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({ map: twig, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.85,
    color: 0x8fa77a, envMapIntensity: 0.6 });
  const spots = [];
  for (let n = 0; n < 9000 && spots.length < 700; n++) {
    // dense woods near the circuit, thinning out further away
    const ring = R() < 0.6;
    const x = ring ? -260 + R() * 640 : -700 + R() * 1500;
    const z = ring ? -440 + R() * 880 : -900 + R() * 1800;
    const i = nearestIndex(track, x, z);
    const d = Math.hypot(x - track.px[i], z - track.pz[i]);
    if (d < WALL_DIST + 10) continue;
    if (x < -8 && x > -60 && z > -165 && z < -25) continue; // grandstand
    spots.push([x, z, 0.75 + R() * 0.7]);
  }
  const trunks = new THREE.InstancedMesh(fir.trunk, barkMat, spots.length);
  const crowns = new THREE.InstancedMesh(fir.foliage, leafMat, spots.length);
  const q = new THREE.Quaternion(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const tint = new THREE.Color();
  spots.forEach(([x, z, s], k) => {
    q.setFromAxisAngle(up, R() * Math.PI * 2);
    m4.compose(v3.set(x, 0, z), q, s3.set(s, s * (0.85 + R() * 0.35), s));
    trunks.setMatrixAt(k, m4); crowns.setMatrixAt(k, m4);
    crowns.setColorAt(k, tint.setHSL(0.26 + R() * 0.06, 0.3 + R() * 0.2, 0.42 + R() * 0.2));
  });
  trunks.castShadow = crowns.castShadow = true;
  scene.add(trunks, crowns);

  // distant rolling hills to give the horizon some depth
  const hillGeoms = [];
  for (let n = 0; n < 34; n++) {
    const a = (n / 34) * Math.PI * 2 + R() * 0.1;
    const r = 1500 + R() * 600, rad = 300 + R() * 300, h = 70 + R() * 140;
    const g = new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const yy = p.getY(k);
      const wob = 1 + Math.sin(p.getX(k) * 7 + n) * 0.06 + Math.cos(p.getZ(k) * 5 + n) * 0.06;
      p.setXYZ(k, p.getX(k) * rad * wob, yy * h * wob, p.getZ(k) * rad * wob);
    }
    g.computeVertexNormals();
    g.translate(125 + Math.cos(a) * r, -8, Math.sin(a) * r);
    hillGeoms.push(g);
  }
  const hills = new THREE.Mesh(mergeGeometries(hillGeoms),
    new THREE.MeshStandardMaterial({ color: 0x55703f, roughness: 1, envMapIntensity: 0.4 }));
  scene.add(hills);

  const ready = Promise.all([hdrReady, new Promise((res) => { manager.onLoad = res; })]);

  return {
    sun, sky, startLights, crowdAnim, ready,
    /** 0..1 loading progress for the loading screen */
    onProgress(cb) { manager.onProgress = (_u, loaded, total) => cb(loaded / total); },
    update(t, focus, camPos) {
      // keep the shadow frustum centred on the player, sun from the HDR's sun
      sun.target.position.set(focus.x, 0, focus.z);
      sun.position.set(focus.x + sunDir.x * 200, sunDir.y * 200, focus.z + sunDir.z * 200);
      if (camPos && Math.hypot(camPos.x + 30, camPos.z + 95) > 260) return;
      const { mesh, base } = crowdAnim;
      for (let k = 0; k < base.length; k += 1) {
        const b = base[k];
        if (b.x === 0 && b.y === 0) continue;
        const jump = Math.max(0, Math.sin(t * 7 + k * 1.7)) * 0.2;
        m4.makeTranslation(b.x, b.y + jump, b.z);
        mesh.setMatrixAt(k, m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    setStartLights(stage) {
      // stage: 0 = off, 1..3 = red lights, 4 = green
      startLights.forEach((m, k) => {
        if (stage === 4) m.color.setRGB(0.2, 4, 0.6);
        else if (k < stage) m.color.setRGB(5, 0.2, 0.15);
        else m.color.setRGB(0.12, 0.0, 0.0);
      });
    },
  };
}
