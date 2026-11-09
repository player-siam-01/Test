// Procedural GT sports car. The body and glasshouse are smooth "lofts":
// rounded cross-sections swept along the car's length, so the paint has real
// curves (and reflections) instead of box edges.
import * as THREE from 'three';
import { radialTexture } from './world.js';

const sgnPow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * Sweep a rounded cross-section along z.
 * stations: [{ z, w (half width), y0 (bottom), y1 (top), n (top roundness) }]
 * lower: width factor for the lower half (tucks the sills in under the fenders)
 */
function loft(stations, { rings = 44, segs = 36, nb = 6, lower = 1 } = {}) {
  const keys = ['z', 'w', 'y0', 'y1', 'n'];
  const S = stations.length;
  const sample = (u) => {
    const f = u * (S - 1), i = Math.min(S - 2, Math.floor(f)), t = f - i;
    const g = (k, j) => stations[Math.max(0, Math.min(S - 1, j))][k];
    const o = {};
    for (const k of keys) o[k] = catmull(g(k, i - 1), g(k, i), g(k, i + 1), g(k, i + 2), t);
    return o;
  };
  const pos = [], idx = [];
  const ring = [];
  for (let r = 0; r <= rings; r++) {
    const st = sample(r / rings);
    const yc = (st.y0 + st.y1) / 2, h = (st.y1 - st.y0) / 2;
    const row = [];
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const ex = s >= 0 ? st.n : nb;
      let x = st.w * sgnPow(c, 2 / ex);
      x *= lower + (1 - lower) * smooth(-0.55, 0.25, s);
      const y = yc + h * sgnPow(s, 2 / ex);
      row.push([x, y, st.z]);
    }
    ring.push(row);
    for (const p of row) pos.push(...p);
  }
  for (let r = 0; r < rings; r++) {
    for (let k = 0; k < segs; k++) {
      const a = r * segs + k, b = r * segs + (k + 1) % segs;
      const c = (r + 1) * segs + k, d = (r + 1) * segs + (k + 1) % segs;
      idx.push(a, b, c, b, d, c);
    }
  }
  // end caps with their own vertices so the side normals stay smooth
  for (const [r, dir] of [[0, -1], [rings, 1]]) {
    const base = pos.length / 3;
    const row = ring[r];
    let cy = 0; for (const p of row) cy += p[1]; cy /= row.length;
    pos.push(0, cy, row[0][2]);
    for (const p of row) pos.push(...p);
    for (let k = 0; k < segs; k++) {
      const a = base + 1 + k, b = base + 1 + (k + 1) % segs;
      if (dir > 0) idx.push(base, a, b); else idx.push(base, b, a);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const BODY = [
  { z: -2.27, w: 0.78, y0: 0.36, y1: 0.68, n: 3 },
  { z: -2.18, w: 0.92, y0: 0.27, y1: 0.83, n: 3.4 },
  { z: -1.85, w: 0.99, y0: 0.23, y1: 0.89, n: 4 },
  { z: -1.40, w: 1.00, y0: 0.22, y1: 0.89, n: 4.2 },
  { z: -0.80, w: 0.955, y0: 0.21, y1: 0.85, n: 4.2 },
  { z: -0.10, w: 0.945, y0: 0.21, y1: 0.83, n: 4.2 },
  { z: 0.60, w: 0.955, y0: 0.21, y1: 0.79, n: 4.2 },
  { z: 1.30, w: 0.985, y0: 0.22, y1: 0.73, n: 4 },
  { z: 1.78, w: 0.95, y0: 0.24, y1: 0.63, n: 3.6 },
  { z: 2.10, w: 0.87, y0: 0.26, y1: 0.53, n: 3 },
  { z: 2.28, w: 0.70, y0: 0.29, y1: 0.44, n: 2.6 },
];
const CABIN = [
  { z: -1.72, w: 0.64, y0: 0.70, y1: 0.86, n: 2.4 },
  { z: -1.25, w: 0.71, y0: 0.72, y1: 1.09, n: 2.6 },
  { z: -0.65, w: 0.735, y0: 0.73, y1: 1.235, n: 2.7 },
  { z: -0.05, w: 0.725, y0: 0.73, y1: 1.245, n: 2.7 },
  { z: 0.45, w: 0.69, y0: 0.72, y1: 1.10, n: 2.6 },
  { z: 0.98, w: 0.64, y0: 0.70, y1: 0.80, n: 2.4 },
];
const ROOF = [
  { z: -1.05, w: 0.50, y0: 1.08, y1: 1.16, n: 3 },
  { z: -0.70, w: 0.60, y0: 1.15, y1: 1.252, n: 3 },
  { z: -0.10, w: 0.60, y0: 1.16, y1: 1.262, n: 3 },
  { z: 0.28, w: 0.52, y0: 1.10, y1: 1.18, n: 3 },
];

/**
 * Merge every mesh under `group` (except `keep`) into one mesh per material.
 * Turns ~100 draw calls per car into a handful; visuals are unchanged.
 */
function bakeByMaterial(group, keep = new Set()) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map();
  const victims = [];
  group.traverse((o) => {
    if (!o.isMesh || keep.has(o) || o === group) return;
    let p = o.parent, skip = false;
    while (p && p !== group) { if (keep.has(p)) skip = true; p = p.parent; }
    if (skip) return;
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone());
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if (!buckets.has(o.material)) buckets.set(o.material, []);
    buckets.get(o.material).push(g);
    victims.push(o);
  });
  for (const o of victims) o.parent.remove(o);
  for (const [mat, geoms] of buckets) {
    let n = 0; for (const g of geoms) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    let off = 0;
    for (const g of geoms) {
      pos.set(g.attributes.position.array, off * 3);
      if (!g.attributes.normal) g.computeVertexNormals();
      nor.set(g.attributes.normal.array, off * 3);
      off += g.attributes.position.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
  }
}

let shared;
function sharedAssets() {
  if (shared) return shared;
  const glow = radialTexture([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]);
  const blob = radialTexture([[0, 'rgba(0,0,0,0.85)'], [0.55, 'rgba(0,0,0,0.5)'], [1, 'rgba(0,0,0,0)']]);
  // tyre: rounded profile lathed around the axle
  const tp = [[0.24, -0.15], [0.32, -0.155], [0.352, -0.13], [0.365, -0.07], [0.367, 0], [0.365, 0.07], [0.352, 0.13], [0.32, 0.155], [0.24, 0.15]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const tireGeo = new THREE.LatheGeometry(tp, 40).rotateZ(Math.PI / 2);
  shared = {
    glow, blob, tireGeo,
    body: loft(BODY, { lower: 0.84 }),
    cabin: loft(CABIN, { nb: 3 }),
    roof: loft(ROOF, { rings: 16, segs: 28 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.78, metalness: 0 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xc9ccd6, metalness: 1, roughness: 0.16 }),
    rimDark: new THREE.MeshStandardMaterial({ color: 0x2a2c33, metalness: 0.9, roughness: 0.3 }),
    disc: new THREE.MeshStandardMaterial({ color: 0x77787d, metalness: 0.9, roughness: 0.45 }),
    caliper: new THREE.MeshStandardMaterial({ color: 0xd8102a, metalness: 0.3, roughness: 0.35 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x05070d, metalness: 0.1, roughness: 0.02, clearcoat: 1,
      clearcoatRoughness: 0.02, envMapIntensity: 2.2 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x0a0a0e, metalness: 0.4, roughness: 0.45 }),
    carbon: new THREE.MeshStandardMaterial({ color: 0x15161a, metalness: 0.6, roughness: 0.28 }),
    head: new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 5, 4.6), toneMapped: false }),
    lens: new THREE.MeshPhysicalMaterial({ color: 0x9fb6d0, metalness: 0.2, roughness: 0.05, clearcoat: 1, envMapIntensity: 1.5 }),
    archGeo: new THREE.TorusGeometry(0.42, 0.055, 8, 28, Math.PI).rotateY(Math.PI / 2),
    rimGeo: new THREE.CylinderGeometry(0.255, 0.255, 0.05, 32).rotateZ(Math.PI / 2),
    barrelGeo: new THREE.CylinderGeometry(0.245, 0.245, 0.24, 24, 1, true).rotateZ(Math.PI / 2),
    spokeGeo: new THREE.BoxGeometry(0.035, 0.24, 0.055),
    capGeo: new THREE.CylinderGeometry(0.055, 0.055, 0.06, 16).rotateZ(Math.PI / 2),
    discGeo: new THREE.CylinderGeometry(0.2, 0.2, 0.03, 28).rotateZ(Math.PI / 2),
  };
  return shared;
}

function buildWheel(A, outward) {
  const wheel = new THREE.Group();
  const tire = new THREE.Mesh(A.tireGeo, A.tire);
  tire.castShadow = true;
  wheel.add(tire);
  const barrel = new THREE.Mesh(A.barrelGeo, A.rimDark);
  wheel.add(barrel);
  const face = new THREE.Group();
  face.position.x = outward * 0.1;
  const dish = new THREE.Mesh(A.rimGeo, A.rimDark);
  dish.position.x = -outward * 0.03;
  face.add(dish);
  for (let k = 0; k < 5; k++) {
    // twin-spoke design
    for (const off of [-0.09, 0.09]) {
      const sp = new THREE.Mesh(A.spokeGeo, A.rim);
      const a = (k / 5) * Math.PI * 2 + off;
      sp.position.set(0, Math.cos(a) * 0.125, Math.sin(a) * 0.125);
      sp.rotation.x = a;
      face.add(sp);
    }
  }
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.012, 6, 36).rotateY(Math.PI / 2), A.rim);
  face.add(lip);
  const cap = new THREE.Mesh(A.capGeo, A.rim);
  face.add(cap);
  wheel.add(face);
  bakeByMaterial(wheel);
  return wheel;
}

export function buildCar(color) {
  const A = sharedAssets();
  const car = new THREE.Group();
  const body = new THREE.Group();
  car.add(body);

  const paint = new THREE.MeshPhysicalMaterial({
    color, metalness: 0.65, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.6,
  });

  const shell = new THREE.Mesh(A.body, paint);
  shell.castShadow = true; shell.receiveShadow = true;
  body.add(shell);
  const cabin = new THREE.Mesh(A.cabin, A.glass);
  cabin.castShadow = true;
  body.add(cabin);
  const roof = new THREE.Mesh(A.roof, paint);
  body.add(roof);

  // contrast stripes running over the bonnet and roof
  const stripeMat = new THREE.MeshPhysicalMaterial({ color: 0xf2f2f6, roughness: 0.25, clearcoat: 1, metalness: 0.2 });
  const stripe = new THREE.Mesh(loft([
    { z: 0.95, w: 0.2, y0: 0.62, y1: 0.805, n: 4 }, { z: 1.4, w: 0.2, y0: 0.6, y1: 0.745, n: 4 },
    { z: 1.85, w: 0.2, y0: 0.5, y1: 0.645, n: 4 }, { z: 2.12, w: 0.2, y0: 0.4, y1: 0.535, n: 4 },
  ], { rings: 12, segs: 16 }), stripeMat);
  body.add(stripe);

  // dark lower trim: splitter, side skirts, diffuser with fins
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.04, 0.32), A.carbon);
  splitter.position.set(0, 0.25, 2.12);
  body.add(splitter);
  const grille = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 0.1), A.trim);
  grille.position.set(0, 0.36, 2.2);
  body.add(grille);
  for (const s of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 2.2), A.carbon);
    skirt.position.set(s * 0.86, 0.24, 0);
    body.add(skirt);
    const arch = new THREE.Mesh(A.archGeo, A.trim);
    arch.position.set(s * 0.93, 0.37, 1.36);
    body.add(arch);
    const arch2 = arch.clone(); arch2.position.z = -1.4;
    body.add(arch2);
    // side mirror
    const mirror = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8).scale(1, 0.6, 1.4), paint);
    mirror.position.set(s * 0.82, 0.92, 0.62);
    body.add(mirror);
    // side intake
    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.14, 0.42), A.trim);
    intake.position.set(s * 0.985, 0.55, -1.0);
    body.add(intake);
  }
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.14, 0.2), A.carbon);
  diffuser.position.set(0, 0.3, -2.2);
  body.add(diffuser);
  for (let k = -2; k <= 2; k++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.14, 0.24), A.carbon);
    fin.position.set(k * 0.28, 0.3, -2.22);
    body.add(fin);
  }

  // rear wing
  const wing = new THREE.Mesh(loft([
    { z: -2.2, w: 0.95, y0: 1.06, y1: 1.08, n: 2 }, { z: -2.02, w: 0.95, y0: 1.07, y1: 1.12, n: 2 },
    { z: -1.85, w: 0.95, y0: 1.08, y1: 1.1, n: 2 },
  ], { rings: 6, segs: 12, nb: 2 }), A.carbon);
  wing.castShadow = true;
  body.add(wing);
  for (const s of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.24, 0.14), A.carbon);
    strut.position.set(s * 0.5, 0.95, -2.02);
    body.add(strut);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.2, 0.42), A.carbon);
    plate.position.set(s * 0.96, 1.09, -2.02);
    body.add(plate);
  }

  // headlights: lens + LED strip; taillights: full-width light bar
  for (const s of [-1, 1]) {
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 10).scale(1.4, 0.32, 0.9), A.lens);
    lens.position.set(s * 0.6, 0.55, 1.96);
    lens.rotation.x = 0.35;
    body.add(lens);
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.025, 0.03), A.head);
    led.position.set(s * 0.6, 0.555, 2.12);
    led.rotation.set(-0.45, s * 0.2, 0);
    body.add(led);
  }
  const tailMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.3, 0.04, 0.06), toneMapped: false });
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.035, 0.03), tailMat);
  tail.position.set(0, 0.73, -2.235);
  body.add(tail);
  for (const s of [-1, 1]) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.03), tailMat);
    c.position.set(s * 0.8, 0.66, -2.22);
    body.add(c);
  }

  // exhausts + nitro flames
  const flameMat = new THREE.MeshBasicMaterial({ map: A.glow, color: new THREE.Color(0.6, 0.9, 5), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flames = [];
  for (const s of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.16, 16, 1, true).rotateX(Math.PI / 2), A.rim);
    pipe.position.set(s * 0.2, 0.32, -2.3);
    body.add(pipe);
    const fl = new THREE.Mesh(new THREE.ConeGeometry(0.1, 1, 12, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5), flameMat);
    fl.position.set(s * 0.2, 0.32, -2.36);
    fl.visible = false;
    body.add(fl);
    flames.push(fl);
  }

  // collapse the static bodywork into one mesh per material (flames stay separate: they toggle)
  bakeByMaterial(body, new Set(flames));

  // wheels with brake discs and calipers (calipers don't spin)
  const wheels = [], steerPivots = [];
  for (const [x, z, front] of [[-0.9, 1.36, true], [0.9, 1.36, true], [-0.9, -1.4, false], [0.9, -1.4, false]]) {
    const outward = Math.sign(x);
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.367, z);
    const wheel = buildWheel(A, outward);
    pivot.add(wheel);
    const disc = new THREE.Mesh(A.discGeo, A.disc);
    disc.position.x = outward * 0.02;
    pivot.add(disc);
    const cal = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, 0.2), A.caliper);
    cal.position.set(outward * 0.04, 0.12, -0.1 * Math.sign(z));
    pivot.add(cal);
    car.add(pivot);
    wheels.push(wheel);
    if (front) steerPivots.push(pivot);
  }

  // subtle underglow + contact shadow
  const glowMat = new THREE.MeshBasicMaterial({ map: A.glow, color: new THREE.Color(color).multiplyScalar(1.1),
    transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false });
  const under = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 5.8), glowMat);
  under.rotation.x = -Math.PI / 2; under.position.y = 0.06;
  car.add(under);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 5.2),
    new THREE.MeshBasicMaterial({ map: A.blob, transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.055;
  car.add(blob);

  return {
    group: car, body, wheels, steerPivots, flames, tailMat, paint, glowMat,
    setColor(c) { paint.color.set(c); glowMat.color.set(c).multiplyScalar(1.1); },
    /** Sync with simulation state. */
    sync(state, dt, t) {
      // rx/rz/rh/rw: pose interpolated between physics steps (falls back to raw state)
      car.position.set(state.rx ?? state.x, 0, state.rz ?? state.z);
      car.rotation.y = state.rh ?? state.heading;
      for (const w of wheels) w.rotation.x = state.rw ?? state.wheelSpin;
      for (const p of steerPivots) p.rotation.y = -state.steer * 0.45;
      const roll = THREE.MathUtils.clamp(state.steer * Math.min(1, Math.abs(state.speed) / 40) * 0.045 + (state.driftSign || 0) * 0.025, -0.08, 0.08);
      const pitch = state.braking ? 0.022 : state.throttle > 0 ? -0.012 : 0;
      body.rotation.z += (roll - body.rotation.z) * Math.min(1, dt * 8);
      body.rotation.x += (pitch - body.rotation.x) * Math.min(1, dt * 6);
      tailMat.color.setRGB(state.braking ? 4.5 : 1.3, state.braking ? 0.12 : 0.04, state.braking ? 0.15 : 0.06);
      for (const f of flames) {
        f.visible = !!state.nitroActive;
        if (f.visible) f.scale.set(1 + Math.random() * 0.3, 1 + Math.random() * 0.3, (0.8 + Math.random() * 0.6) * 1.6);
      }
      glowMat.opacity = 0.4 + Math.sin(t * 5 + state.id) * 0.08;
    },
  };
}
