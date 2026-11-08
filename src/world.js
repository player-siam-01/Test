// Builds the 3D environment: sky, lighting, track surfaces, barriers, scenery.
import * as THREE from 'three';
import { ROAD_HALF, CURB_WIDTH, WALL_DIST, nearestIndex, wrap } from './track.js';

export const SUN_DIR = new THREE.Vector3(0.22, 0.09, 1).normalize();

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

/** Horizontal ribbon following the track between lateral offsets a..b. */
function ribbon(track, a, b, y, vLen) {
  const { N, px, pz, sx, sz, ds } = track;
  const reps = Math.max(1, Math.round(track.length / vLen));
  const pos = [], uv = [], idx = [];
  for (let k = 0; k <= N; k++) {
    const i = k % N;
    const v = (k * ds / track.length) * reps;
    pos.push(px[i] + sx[i] * a, y, pz[i] + sz[i] * a, px[i] + sx[i] * b, y, pz[i] + sz[i] * b);
    uv.push(0, v, 1, v);
    if (k < N) { const o = k * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Vertical ribbon at lateral offset d, from y0 to y1. */
function wallRibbon(track, d, y0, y1, vLen) {
  const { N, px, pz, sx, sz, ds } = track;
  const reps = Math.max(1, Math.round(track.length / vLen));
  const pos = [], uv = [], idx = [];
  for (let k = 0; k <= N; k++) {
    const i = k % N;
    const x = px[i] + sx[i] * d, z = pz[i] + sz[i] * d;
    const u = (k * ds / track.length) * reps;
    pos.push(x, y0, z, x, y1, z);
    uv.push(u, 0, u, 1);
    if (k < N) { const o = k * 2; idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function mergeGeometries(geoms) {
  const pos = [], nor = [], uv = [], col = [];
  for (const g0 of geoms) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    uv.push(...g.attributes.uv.array);
    if (g.attributes.color) col.push(...g.attributes.color.array);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (col.length) out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { sunDir: { value: SUN_DIR } },
    vertexShader: `varying vec3 vDir;
      void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `varying vec3 vDir; uniform vec3 sunDir;
      float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
      void main(){
        vec3 d = normalize(vDir); float h = d.y;
        vec3 top = vec3(0.004,0.003,0.03), mid = vec3(0.12,0.015,0.16), hor = vec3(0.9,0.22,0.12);
        vec3 col = mix(hor, mid, smoothstep(0.0, 0.16, h));
        col = mix(col, top, smoothstep(0.12, 0.55, h));
        col = mix(col, vec3(0.06,0.01,0.05), smoothstep(0.0, -0.12, h));
        float dist = distance(d, sunDir);
        float sun = smoothstep(0.125, 0.12, dist);
        float rel = d.y - sunDir.y;
        float bands = step(0.42, fract(rel * 55.0));
        sun *= mix(1.0, bands, smoothstep(0.0, -0.02, rel));
        vec3 sunCol = mix(vec3(1.0,0.85,0.25), vec3(1.0,0.12,0.45), clamp(0.5 - rel * 9.0, 0.0, 1.0));
        col += sunCol * sun * 1.7;
        col += vec3(1.0,0.3,0.25) * pow(max(0.0, 1.0 - dist), 7.0) * 0.55;
        float s = hash(floor(d * 420.0));
        col += vec3(0.9,0.9,1.0) * step(0.9975, s) * smoothstep(0.18, 0.5, h) * 1.6;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 48, 24), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

export function buildWorld(scene, renderer, track) {
  const R = rng(1337);
  const disposables = [];
  const sky = makeSky();
  scene.add(sky);

  // Environment map for glossy car paint / reflections
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(makeSky());
  const envRT = pmrem.fromScene(envScene, 0.02);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.9;
  pmrem.dispose();

  scene.fog = new THREE.Fog(0x4a1a4a, 140, 1600);

  const hemi = new THREE.HemisphereLight(0x8a7cff, 0x2a0f22, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffb48a, 2.6);
  sun.position.copy(SUN_DIR).multiplyScalar(150);
  sun.castShadow = true;
  {
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -70; c.right = 70; c.top = 70; c.bottom = -70; c.near = 1; c.far = 400;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
  }
  scene.add(sun, sun.target);

  // Ground
  const groundTex = canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = '#16301f'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) {
      const v = R();
      g.fillStyle = v > 0.5 ? `rgba(40,80,45,${R() * 0.5})` : `rgba(8,20,12,${R() * 0.5})`;
      g.fillRect(R() * w, R() * h, 2 + R() * 3, 2 + R() * 3);
    }
  }, { repeat: [220, 220] });
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Asphalt
  const roadTex = canvasTexture(512, 1024, (g, w, h) => {
    g.fillStyle = '#26262c'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26000; i++) {
      const c = 25 + R() * 40;
      g.fillStyle = `rgba(${c},${c},${c + 6},${0.35 + R() * 0.5})`;
      g.fillRect(R() * w, R() * h, 1 + R() * 2, 1 + R() * 2);
    }
    // tyre-worn racing groove
    const gr = g.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0.25, 'rgba(0,0,0,0)'); gr.addColorStop(0.4, 'rgba(0,0,0,0.22)');
    gr.addColorStop(0.6, 'rgba(0,0,0,0.22)'); gr.addColorStop(0.75, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = '#e8e8e8';
    g.fillRect(w * 0.035, 0, w * 0.022, h);
    g.fillRect(w * 0.943, 0, w * 0.022, h);
    g.fillStyle = '#f2c230';
    g.fillRect(w * 0.492, 0, w * 0.016, h * 0.45);
  }, { repeat: [1, 1] });
  const road = new THREE.Mesh(ribbon(track, -ROAD_HALF, ROAD_HALF, 0.02, 18),
    new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.62, metalness: 0.15, envMapIntensity: 0.6 }));
  road.receiveShadow = true;
  scene.add(road);

  // Curbs
  const curbTex = canvasTexture(64, 128, (g, w, h) => {
    g.fillStyle = '#e01a3c'; g.fillRect(0, 0, w, h / 2);
    g.fillStyle = '#f4f4f4'; g.fillRect(0, h / 2, w, h / 2);
  });
  const curbMat = new THREE.MeshStandardMaterial({ map: curbTex, roughness: 0.5,
    polygonOffset: true, polygonOffsetFactor: -1 });
  for (const s of [-1, 1]) {
    const a = s * ROAD_HALF, b = s * (ROAD_HALF + CURB_WIDTH);
    const m = new THREE.Mesh(ribbon(track, Math.min(a, b), Math.max(a, b), 0.04, 4), curbMat);
    m.receiveShadow = true;
    scene.add(m);
  }
  // gravel run-off strip
  const gravelTex = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#3a3036'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 6000; i++) { const c = 50 + R() * 60; g.fillStyle = `rgb(${c},${c * 0.85},${c * 0.9})`; g.fillRect(R() * w, R() * h, 2, 2); }
  });
  const gravelMat = new THREE.MeshStandardMaterial({ map: gravelTex, roughness: 1 });
  for (const s of [-1, 1]) {
    const a = s * (ROAD_HALF + CURB_WIDTH), b = s * (WALL_DIST + 0.3);
    scene.add(new THREE.Mesh(ribbon(track, Math.min(a, b), Math.max(a, b), 0.012, 10), gravelMat));
  }

  // Barriers with neon tubes
  const wallTex = canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = '#1b1b26'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#2c2c3e';
    for (let x = 0; x < w; x += 32) g.fillRect(x, 0, 16, h);
    g.fillStyle = '#ddd'; g.fillRect(0, h * 0.42, w, h * 0.08);
  });
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.45, metalness: 0.6, side: THREE.DoubleSide });
  const neonL = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x24e8ff).multiplyScalar(4), toneMapped: false });
  const neonR = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2bd6).multiplyScalar(4), toneMapped: false });
  for (const s of [-1, 1]) {
    const d = s * WALL_DIST;
    const w = new THREE.Mesh(wallRibbon(track, d, 0, 1.15, 8), wallMat);
    w.castShadow = true; w.receiveShadow = true;
    scene.add(w);
    const tube = new THREE.Mesh(wallRibbon(track, d - s * 0.02, 1.1, 1.24, 10), s < 0 ? neonL : neonR);
    scene.add(tube);
    const glow = new THREE.Mesh(ribbon(track, Math.min(d, d - s * 1.6), Math.max(d, d - s * 1.6), 0.03,
      10), new THREE.MeshBasicMaterial({ color: s < 0 ? 0x24e8ff : 0xff2bd6, transparent: true, opacity: 0.12,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(glow);
  }

  // Start / finish line + gantry
  const startTex = canvasTexture(256, 32, (g, w, h) => {
    const n = 16;
    for (let y = 0; y < 2; y++) for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5';
      g.fillRect(x * w / n, y * h / 2, w / n, h / 2);
    }
  });
  const p0 = { x: track.px[0], z: track.pz[0] };
  const h0 = Math.atan2(track.tx[0], track.tz[0]);
  const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 2),
    new THREE.MeshStandardMaterial({ map: startTex, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 }));
  line.rotation.set(-Math.PI / 2, 0, h0);
  line.position.set(p0.x, 0.045, p0.z);
  scene.add(line);

  const gantry = new THREE.Group();
  gantry.position.set(p0.x, 0, p0.z);
  gantry.rotation.y = h0;
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2a35, metalness: 0.8, roughness: 0.3 });
  for (const s of [-1, 1]) {
    const pil = new THREE.Mesh(new THREE.BoxGeometry(0.8, 8, 0.8), metal);
    pil.position.set(s * (WALL_DIST + 0.6), 4, 0); pil.castShadow = true;
    gantry.add(pil);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(WALL_DIST * 2 + 2, 1.8, 1), metal);
  beam.position.y = 8.4; beam.castShadow = true;
  gantry.add(beam);
  const signTex = canvasTexture(1024, 96, (g, w, h) => {
    g.fillStyle = '#05030c'; g.fillRect(0, 0, w, h);
    g.font = 'italic 900 64px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = '#ff2bd6'; g.shadowBlur = 18; g.fillStyle = '#ffd2f6';
    g.fillText('NEON  VELOCITY  GRAND  PRIX', w / 2, h / 2 + 4);
  });
  for (const s of [-1, 1]) {
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(WALL_DIST * 2, 1.5),
      new THREE.MeshBasicMaterial({ map: signTex, toneMapped: false, color: new THREE.Color(1.6, 1.6, 1.6) }));
    sign.position.set(0, 8.4, s * 0.51);
    if (s < 0) sign.rotation.y = Math.PI;
    gantry.add(sign);
  }
  const startLights = [];
  for (let k = 0; k < 3; k++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x220000, toneMapped: false });
    const l = new THREE.Mesh(new THREE.CircleGeometry(0.42, 24), mat);
    l.position.set((k - 1) * 1.3, 7.0, -0.52);
    l.rotation.y = Math.PI;
    const housing = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 0.3), metal);
    housing.position.set((k - 1) * 1.3, 7.0, -0.36);
    gantry.add(housing, l);
    startLights.push(mat);
  }
  scene.add(gantry);

  // Street lamps (instanced) + light pools on the asphalt
  const lampPos = [];
  const step = Math.round(42 / track.ds);
  for (let i = 0, n = 0; i < track.N; i += step, n++) {
    const s = n % 2 ? 1 : -1;
    lampPos.push({ i, s });
  }
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.18, 9, 8);
  poleGeo.translate(0, 4.5, 0);
  const poles = new THREE.InstancedMesh(poleGeo, metal, lampPos.length);
  const armGeo = new THREE.BoxGeometry(0.14, 0.14, 3.2); armGeo.translate(0, 9, 1.5);
  const arms = new THREE.InstancedMesh(armGeo, metal, lampPos.length);
  const bulbGeo = new THREE.BoxGeometry(0.5, 0.18, 1.2); bulbGeo.translate(0, 8.9, 2.9);
  const bulbs = new THREE.InstancedMesh(bulbGeo,
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.75, 0.45).multiplyScalar(6), toneMapped: false }), lampPos.length);
  const poolTex = radialTexture([[0, 'rgba(255,190,120,1)'], [0.5, 'rgba(255,150,90,0.35)'], [1, 'rgba(255,120,80,0)']]);
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }), lampPos.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), v3 = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  lampPos.forEach(({ i, s }, k) => {
    const d = s * (WALL_DIST + 1.6);
    v3.set(track.px[i] + track.sx[i] * d, 0, track.pz[i] + track.sz[i] * d);
    // arm points toward the road (local +z)
    const ang = Math.atan2(-track.sx[i] * s, -track.sz[i] * s);
    q.setFromAxisAngle(up, ang);
    m4.compose(v3, q, sc);
    poles.setMatrixAt(k, m4); arms.setMatrixAt(k, m4); bulbs.setMatrixAt(k, m4);
    const pd = s * (WALL_DIST - 3.5);
    v3.set(track.px[i] + track.sx[i] * pd, 0.05, track.pz[i] + track.sz[i] * pd);
    q.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    m4.compose(v3, q, new THREE.Vector3(16, 16, 1));
    pools.setMatrixAt(k, m4);
  });
  poles.castShadow = true;
  scene.add(poles, arms, bulbs, pools);

  // Chevron boards on the outside of tight corners
  const chevTex = canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = '#0c0c14'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffd21f'; g.shadowColor = '#ffb000'; g.shadowBlur = 8;
    for (let k = 0; k < 4; k++) {
      const x = 20 + k * 60;
      g.beginPath(); g.moveTo(x, 8); g.lineTo(x + 30, h / 2); g.lineTo(x, h - 8); g.lineTo(x + 16, h - 8);
      g.lineTo(x + 46, h / 2); g.lineTo(x + 16, 8); g.closePath(); g.fill();
    }
  });
  const chevMatA = new THREE.MeshBasicMaterial({ map: chevTex, toneMapped: false, color: new THREE.Color(2, 2, 2) });
  const chevTexB = chevTex.clone(); chevTexB.repeat.x = -1; chevTexB.needsUpdate = true;
  const chevMatB = new THREE.MeshBasicMaterial({ map: chevTexB, toneMapped: false, color: new THREE.Color(2, 2, 2) });
  const chevs = [];
  for (let i = 0; i < track.N; i += Math.round(22 / track.ds)) {
    if (Math.abs(track.curv[i]) > 1 / 70) chevs.push(i);
  }
  const chevGeo = new THREE.PlaneGeometry(4, 1);
  for (const i of chevs) {
    const o = Math.sign(track.curv[i]);
    const d = o * (WALL_DIST - 0.08);
    const board = new THREE.Mesh(chevGeo, o < 0 ? chevMatA : chevMatB);
    board.position.set(track.px[i] + track.sx[i] * d, 1.9, track.pz[i] + track.sz[i] * d);
    // face toward the track centre
    board.lookAt(track.px[i], 1.9, track.pz[i]);
    scene.add(board);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.4, 0.1), metal);
    post.position.set(board.position.x, 0.7, board.position.z);
    scene.add(post);
  }

  // Grandstand along the outside of the main straight
  const stand = new THREE.Group();
  const standMat = new THREE.MeshStandardMaterial({ color: 0x3b3550, roughness: 0.7, metalness: 0.2 });
  const crowdMat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const crowdGeo = new THREE.BoxGeometry(0.5, 0.8, 0.4);
  const crowdCount = 6 * 110;
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, crowdCount);
  const palette = [0xff2d6f, 0x22e0ff, 0xffd21f, 0xffffff, 0x9dff3a, 0xff8a1f, 0x7a5cff];
  let ci = 0;
  for (let r = 0; r < 6; r++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(3, 1 + r * 1.2, 100), standMat);
    step.position.set(-(WALL_DIST + 6 + r * 3), (1 + r * 1.2) / 2, -95);
    step.castShadow = true; step.receiveShadow = true;
    stand.add(step);
    for (let k = 0; k < 110; k++) {
      m4.makeTranslation(-(WALL_DIST + 5.5 + r * 3 + R() * 0.8), 1 + r * 1.2 + 0.4, -144 + k * 0.89 + R() * 0.2);
      crowd.setMatrixAt(ci, m4);
      crowd.setColorAt(ci, new THREE.Color(palette[Math.floor(R() * palette.length)]));
      ci++;
    }
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(22, 0.5, 104), metal);
  roof.position.set(-(WALL_DIST + 13), 12, -95); roof.castShadow = true;
  stand.add(roof, crowd);
  const roofNeon = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 104), neonR);
  roofNeon.position.set(-(WALL_DIST + 2.1), 11.8, -95);
  stand.add(roofNeon);
  scene.add(stand);
  const crowdAnim = { mesh: crowd, base: [] };
  for (let k = 0; k < crowdCount; k++) { crowd.getMatrixAt(k, m4); crowdAnim.base.push(new THREE.Vector3().setFromMatrixPosition(m4)); }

  // Trees (instanced) — keep clear of the circuit and grandstand
  const treeSpots = [];
  for (let n = 0; n < 2600 && treeSpots.length < 650; n++) {
    const x = -320 + R() * 760, z = -480 + R() * 960;
    const i = nearestIndex(track, x, z);
    const d = Math.hypot(x - track.px[i], z - track.pz[i]);
    if (d < WALL_DIST + 7) continue;
    if (x < -10 && x > -50 && z > -160 && z < -30) continue;
    treeSpots.push([x, z, 0.7 + R() * 0.8]);
  }
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.4, 3, 6).translate(0, 1.5, 0),
    new THREE.MeshStandardMaterial({ color: 0x3a2418, roughness: 1 }), treeSpots.length);
  const leafGeo = mergeGeometries([
    new THREE.ConeGeometry(2.6, 5, 7).translate(0, 4.5, 0),
    new THREE.ConeGeometry(2.0, 4, 7).translate(0, 6.8, 0),
    new THREE.ConeGeometry(1.3, 3, 7).translate(0, 8.8, 0),
  ]);
  const leaves = new THREE.InstancedMesh(leafGeo,
    new THREE.MeshStandardMaterial({ color: 0x1d5a3a, roughness: 0.85, flatShading: true }), treeSpots.length);
  const tint = new THREE.Color();
  treeSpots.forEach(([x, z, s], k) => {
    q.setFromAxisAngle(up, R() * Math.PI * 2);
    m4.compose(v3.set(x, 0, z), q, sc.set(s, s * (0.9 + R() * 0.4), s));
    trunk.setMatrixAt(k, m4); leaves.setMatrixAt(k, m4);
    leaves.setColorAt(k, tint.setHSL(0.36 + R() * 0.1, 0.45, 0.22 + R() * 0.12));
  });
  sc.set(1, 1, 1);
  trunk.castShadow = leaves.castShadow = true;
  scene.add(trunk, leaves);

  // City skyline (merged into one draw call)
  const winTex = canvasTexture(128, 256, (g, w, h) => {
    g.fillStyle = '#07060d'; g.fillRect(0, 0, w, h);
    for (let y = 4; y < h; y += 12) for (let x = 4; x < w; x += 10) {
      const r = R();
      if (r < 0.3) {
        g.fillStyle = r < 0.08 ? '#ff7fe1' : r < 0.16 ? '#7fefff' : '#ffd79a';
        g.globalAlpha = 0.5 + R() * 0.5; g.fillRect(x, y, 6, 7); g.globalAlpha = 1;
      }
    }
  });
  const bGeoms = [];
  const center = { x: 125, z: 0 };
  for (let n = 0; n < 110; n++) {
    const a = (n / 110) * Math.PI * 2 + R() * 0.03;
    const r = 820 + R() * 420;
    const w = 25 + R() * 45, d = 25 + R() * 45, hgt = 40 + Math.pow(R(), 1.6) * 230;
    const g = new THREE.BoxGeometry(w, hgt, d);
    const uvA = g.attributes.uv;
    for (let k = 0; k < uvA.count; k++) uvA.setXY(k, uvA.getX(k) * w / 50, uvA.getY(k) * hgt / 70);
    g.rotateY(R() * Math.PI);
    g.translate(center.x + Math.cos(a) * r, hgt / 2, center.z + Math.sin(a) * r);
    bGeoms.push(g);
  }
  const city = new THREE.Mesh(mergeGeometries(bGeoms), new THREE.MeshStandardMaterial({
    color: 0x0c0a16, roughness: 0.6, metalness: 0.4, emissiveMap: winTex, emissive: 0xffffff, emissiveIntensity: 1.4,
  }));
  scene.add(city);

  // Distant mountains
  const mGeoms = [];
  for (let n = 0; n < 40; n++) {
    const a = (n / 40) * Math.PI * 2;
    const r = 1500 + R() * 300, h = 120 + R() * 260, rad = 200 + R() * 220;
    const g = new THREE.ConeGeometry(rad, h, 6 + Math.floor(R() * 3));
    g.translate(center.x + Math.cos(a) * r, h / 2 - 5, center.z + Math.sin(a) * r);
    mGeoms.push(g);
  }
  const mountains = new THREE.Mesh(mergeGeometries(mGeoms),
    new THREE.MeshStandardMaterial({ color: 0x2a1238, roughness: 1, flatShading: true }));
  scene.add(mountains);

  return {
    sun, sky, startLights, crowdAnim,
    update(t, focus, camPos) {
      if (camPos) sky.position.copy(camPos);
      // keep shadow frustum around the focus point
      sun.target.position.set(focus.x, 0, focus.z);
      sun.position.set(focus.x + SUN_DIR.x * 150, SUN_DIR.y * 150 + 60, focus.z + SUN_DIR.z * 150);
      // cheering crowd
      const { mesh, base } = crowdAnim;
      for (let k = 0; k < base.length; k += 1) {
        const b = base[k];
        const jump = Math.max(0, Math.sin(t * 7 + k * 1.7)) * 0.25;
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
