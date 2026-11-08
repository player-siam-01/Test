// GPU point-sprite particles (smoke, sparks, dust) and skid-mark decals.
import * as THREE from 'three';
import { radialTexture } from './world.js';

export class Particles {
  constructor(max, { additive = false, gravity = 0, drag = 1.2, grow = 1.5 } = {}) {
    this.max = max; this.gravity = gravity; this.drag = drag; this.grow = grow;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.size0 = new Float32Array(max);
    this.cursor = 0;
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('size', this.sizeAttr);
    g.setAttribute('alpha', this.alphaAttr);
    g.setAttribute('color', this.colAttr);
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { map: { value: radialTexture([[0, 'rgba(255,255,255,1)'], [0.5, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]) },
        scale: { value: 600 } },
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color;
        varying float vA; varying vec3 vC; uniform float scale;
        void main(){ vA = alpha; vC = color; vec4 mv = modelViewMatrix * vec4(position,1.);
          gl_PointSize = size * scale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying float vA; varying vec3 vC;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC, t.a * vA); if (gl_FragColor.a < 0.01) discard; }`,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
  }

  emit(x, y, z, vx, vy, vz, life, size, r, g, b) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life; this.size0[i] = size;
    this.colAttr.array[i * 3] = r; this.colAttr.array[i * 3 + 1] = g; this.colAttr.array[i * 3 + 2] = b;
  }

  update(dt) {
    const { p, v, life, maxLife, size0 } = this;
    const sz = this.sizeAttr.array, al = this.alphaAttr.array;
    const k = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) { al[i] = 0; continue; }
      life[i] -= dt;
      const t = 1 - Math.max(0, life[i]) / maxLife[i];
      v[i * 3] *= k; v[i * 3 + 1] = v[i * 3 + 1] * k - this.gravity * dt; v[i * 3 + 2] *= k;
      p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
      if (p[i * 3 + 1] < 0.05) { p[i * 3 + 1] = 0.05; v[i * 3 + 1] *= -0.4; }
      sz[i] = size0[i] * (1 + t * this.grow);
      al[i] = (1 - t) * Math.min(1, t * 8);
    }
    this.posAttr.needsUpdate = this.sizeAttr.needsUpdate = this.alphaAttr.needsUpdate = this.colAttr.needsUpdate = true;
  }
}

export class SkidMarks {
  constructor(max = 1400) {
    this.max = max; this.cursor = 0;
    const mat = new THREE.MeshBasicMaterial({ color: 0x050505, transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4 });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.3, 1).rotateX(-Math.PI / 2), mat, max);
    this.mesh.frustumCulled = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < max; i++) this.mesh.setMatrixAt(i, zero);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._v = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this.last = new Map();
  }

  /** Lay a mark segment between the previous and current point for a wheel key. */
  add(key, x, z, intensity) {
    const prev = this.last.get(key);
    this.last.set(key, { x, z });
    if (!prev) return;
    const dx = x - prev.x, dz = z - prev.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05 || len > 4) return;
    this._q.setFromAxisAngle(this._up, Math.atan2(dx, dz));
    this._v.set((x + prev.x) / 2, 0.05, (z + prev.z) / 2);
    this._s.set(0.8 + intensity * 0.4, 1, len);
    this._m.compose(this._v, this._q, this._s);
    this.mesh.setMatrixAt(this.cursor, this._m);
    this.cursor = (this.cursor + 1) % this.max;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  lift(key) { this.last.delete(key); }

  clear() {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.last.clear();
  }
}
