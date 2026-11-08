// Procedural sports-car model: extruded body profile, glass cabin, spinning
// wheels, emissive head/tail lights, neon underglow and nitro flames.
import * as THREE from 'three';
import { radialTexture } from './world.js';

let shared;
function sharedAssets() {
  if (shared) return shared;
  const glow = radialTexture([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]);
  const blob = radialTexture([[0, 'rgba(0,0,0,0.75)'], [0.6, 'rgba(0,0,0,0.4)'], [1, 'rgba(0,0,0,0)']]);
  shared = {
    glow, blob,
    tire: new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.85 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xd8dbe6, metalness: 1, roughness: 0.18 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0a0f1e, metalness: 0.2, roughness: 0.04, clearcoat: 1,
      envMapIntensity: 1.6 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x0b0b10, metalness: 0.5, roughness: 0.4 }),
    head: new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 4, 3.6), toneMapped: false }),
    tireGeo: new THREE.CylinderGeometry(0.37, 0.37, 0.32, 24).rotateZ(Math.PI / 2),
    rimGeo: new THREE.CylinderGeometry(0.25, 0.25, 0.34, 6).rotateZ(Math.PI / 2),
    hubGeo: new THREE.CylinderGeometry(0.08, 0.08, 0.36, 8).rotateZ(Math.PI / 2),
  };
  return shared;
}

function extrudeProfile(points, width, bevel) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 4,
  });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  // shape x = car forward (z), extrusion = car width (x)
  g.rotateY(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

export function buildCar(color) {
  const A = sharedAssets();
  const car = new THREE.Group();
  const body = new THREE.Group();
  car.add(body);

  const paint = new THREE.MeshPhysicalMaterial({
    color, metalness: 0.55, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.25,
  });

  // lower body (side profile: [forward, up])
  const lower = extrudeProfile([
    [-2.2, 0.3], [2.05, 0.3], [2.28, 0.42], [2.24, 0.56], [1.95, 0.68], [0.7, 0.8],
    [-1.6, 0.88], [-2.2, 0.86], [-2.28, 0.6],
  ], 1.92, 0.09);
  const bodyMesh = new THREE.Mesh(lower, paint);
  bodyMesh.castShadow = true;
  body.add(bodyMesh);

  // cabin / glass
  const cabin = extrudeProfile([
    [0.75, 0.78], [-0.15, 1.24], [-1.15, 1.24], [-1.85, 0.88], [-1.6, 0.8],
  ], 1.5, 0.07);
  const cabinMesh = new THREE.Mesh(cabin, A.glass);
  cabinMesh.castShadow = true;
  body.add(cabinMesh);
  // roof panel in body colour
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.05, 0.85), paint);
  roof.position.set(0, 1.3, -0.66);
  body.add(roof);

  // racing stripes
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.3, metalness: 0.1 });
  for (const s of [-1, 1]) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 1.32), stripeMat);
    st.position.set(s * 0.18, 0.82, 1.35);
    st.rotation.x = Math.atan2(0.12, 1.25);
    body.add(st);
  }

  // side skirts, splitter, diffuser
  for (const s of [-1, 1]) {
    const sk = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 2.6), A.trim);
    sk.position.set(s * 0.98, 0.33, 0);
    body.add(sk);
  }
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.05, 0.3), A.trim);
  splitter.position.set(0, 0.28, 2.22);
  body.add(splitter);
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.18, 0.2), A.trim);
  diffuser.position.set(0, 0.35, -2.25);
  body.add(diffuser);

  // spoiler
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.06, 0.42), paint);
  wing.position.set(0, 1.2, -1.98);
  wing.rotation.x = -0.12;
  wing.castShadow = true;
  body.add(wing);
  for (const s of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.16), A.trim);
    strut.position.set(s * 0.6, 1.0, -1.98);
    body.add(strut);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.24, 0.5), A.trim);
    plate.position.set(s * 0.98, 1.18, -1.98);
    body.add(plate);
  }

  // lights
  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.07, 0.06), A.head);
    hl.position.set(s * 0.62, 0.6, 2.22);
    hl.rotation.x = -0.5;
    body.add(hl);
  }
  const tailMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.05, 0.08), toneMapped: false });
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.05), tailMat);
  tail.position.set(0, 0.74, -2.29);
  body.add(tail);

  // exhausts + nitro flames
  const flameMat = new THREE.MeshBasicMaterial({ map: A.glow, color: new THREE.Color(0.6, 0.8, 4), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flames = [];
  for (const s of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.2, 12).rotateX(Math.PI / 2), A.rim);
    pipe.position.set(s * 0.45, 0.38, -2.32);
    body.add(pipe);
    const fl = new THREE.Mesh(new THREE.ConeGeometry(0.12, 1, 10, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5), flameMat);
    fl.position.set(s * 0.45, 0.38, -2.4);
    fl.visible = false;
    body.add(fl);
    flames.push(fl);
  }

  // wheels
  const wheels = [], steerPivots = [];
  for (const [x, z, front] of [[-0.92, 1.38, true], [0.92, 1.38, true], [-0.92, -1.38, false], [0.92, -1.38, false]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.37, z);
    const wheel = new THREE.Group();
    wheel.add(new THREE.Mesh(A.tireGeo, A.tire));
    const rim = new THREE.Mesh(A.rimGeo, A.rim);
    wheel.add(rim, new THREE.Mesh(A.hubGeo, A.trim));
    wheel.children[0].castShadow = true;
    pivot.add(wheel);
    car.add(pivot);
    wheels.push(wheel);
    if (front) steerPivots.push(pivot);
  }

  // underglow + blob shadow
  const glowMat = new THREE.MeshBasicMaterial({ map: A.glow, color: new THREE.Color(color).multiplyScalar(1.4),
    transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  const under = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 6.2), glowMat);
  under.rotation.x = -Math.PI / 2; under.position.y = 0.06;
  car.add(under);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 5.4),
    new THREE.MeshBasicMaterial({ map: A.blob, transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.055;
  car.add(blob);

  return {
    group: car, body, wheels, steerPivots, flames, tailMat, paint, glowMat,
    setColor(c) { paint.color.set(c); glowMat.color.set(c).multiplyScalar(1.4); },
    /** Sync with simulation state. */
    sync(state, dt, t) {
      car.position.set(state.x, 0, state.z);
      car.rotation.y = state.heading;
      for (const w of wheels) w.rotation.x = state.wheelSpin;
      for (const p of steerPivots) p.rotation.y = -state.steer * 0.45;
      // body roll / pitch for weight transfer
      const roll = THREE.MathUtils.clamp(state.steer * Math.min(1, Math.abs(state.speed) / 40) * 0.05 + state.driftSign * 0.03, -0.09, 0.09);
      const pitch = state.braking ? 0.025 : state.throttle > 0 ? -0.015 : 0;
      body.rotation.z += (roll - body.rotation.z) * Math.min(1, dt * 8);
      body.rotation.x += (pitch - body.rotation.x) * Math.min(1, dt * 6);
      tailMat.color.setRGB(state.braking ? 8 : 1.6, state.braking ? 0.2 : 0.05, state.braking ? 0.25 : 0.08);
      for (const f of flames) {
        f.visible = state.nitroActive;
        if (f.visible) {
          const s = 0.8 + Math.random() * 0.6;
          f.scale.set(1 + Math.random() * 0.3, 1 + Math.random() * 0.3, s * 1.6);
        }
      }
      glowMat.opacity = 0.7 + Math.sin(t * 6 + state.id) * 0.15;
    },
  };
}
