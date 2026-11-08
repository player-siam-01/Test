// Arcade car physics + AI driver. Pure logic: runs identically in the render
// loop and in the headless fixed-step simulation used by the E2E tests.
import { ROAD_HALF, CURB_WIDTH, WALL_DIST, locate, pointAt, wrap } from './track.js';

export const SPEC = {
  maxSpeed: 70,      // m/s (~252 km/h)
  engine: 24,        // m/s^2 at standstill
  brake: 40,
  reverseMax: 14,
  maxTurn: 2.4,      // rad/s at low speed
  grip: 7.5,
  driftGrip: 1.4,
  nitroBoost: 16,
  nitroDuration: 3.2, // seconds for a full tank
  nitroRegen: 1 / 16, // tank per second
};

export const CAR_RADIUS = 1.35;

export class Car {
  constructor({ id, name, color, isPlayer = false, skill = 1, lane = 0 }) {
    Object.assign(this, { id, name, color, isPlayer, skill, lane });
    this.x = 0; this.z = 0; this.heading = 0;
    this.vx = 0; this.vz = 0;
    this.speed = 0;          // forward speed (m/s)
    this.steer = 0;          // smoothed steering (-1 left .. 1 right)
    this.nitro = 1;          // tank 0..1
    this.nitroActive = false;
    this.idx = -1;           // nearest track sample
    this.progressF = 0;      // fractional index
    this.lapCounter = -1;    // -1 = behind the start line on the grid
    this.lat = 0;
    this.drift = 0;          // lateral slip speed
    this.offroad = false;
    this.wrongWay = false;
    this.wallImpact = 0;     // impact speed of last wall hit this step
    this.finished = false;
    this.finishTime = null;
    this.lapTimes = [];
    this.lapStart = 0;
    this.throttle = 0;
    this.braking = false;
    this.wheelSpin = 0;
    this.avoid = 0;
  }
  get progress() { return this.lapCounter * 1e5 + this.progressF; }
}

/** Speed the AI can carry at every sample, with a braking back-pass. */
export function buildSpeedTable(track, spec = SPEC) {
  const { N, ds } = track;
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let c = 0;
    for (let k = -6; k <= 6; k++) c = Math.max(c, Math.abs(track.curv[wrap(i + k, N)]));
    const R = c > 1e-5 ? 1 / c : 1e5;
    let v = 8;
    for (let t = 8; t <= spec.maxSpeed * 1.3; t += 0.5) {
      const omega = spec.maxTurn * (1 - 0.5 * Math.min(1, t / spec.maxSpeed));
      if (t <= 0.62 * omega * R) v = t; else break;
    }
    raw[i] = v;
  }
  const decel = 24;
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 2 * N - 1; j >= 0; j--) {
      const i = j % N, n = (i + 1) % N;
      raw[i] = Math.min(raw[i], Math.sqrt(raw[n] * raw[n] + 2 * decel * ds));
    }
  }
  return raw;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Advance one car by dt seconds.
 * input: { throttle 0..1, brake 0..1, steer -1..1 (+right), handbrake, nitro }
 */
export function stepCar(car, input, track, dt, spec = SPEC) {
  car.steer += (input.steer - car.steer) * Math.min(1, dt * 9);
  car.throttle = input.throttle;
  car.braking = input.brake > 0.1;
  const N = track.N;

  let fx = Math.sin(car.heading), fz = Math.cos(car.heading);
  let rx = -fz, rz = fx;
  let vF = car.vx * fx + car.vz * fz;
  let vL = car.vx * rx + car.vz * rz;

  const loc0 = locate(track, car.x, car.z, car.idx);
  const absLat = Math.abs(loc0.lat);
  car.offroad = absLat > ROAD_HALF + CURB_WIDTH * 0.7;

  // Nitro
  const wantsNitro = input.nitro && car.nitro > 0.02 && vF > 5;
  car.nitroActive = wantsNitro;
  if (wantsNitro) car.nitro = Math.max(0, car.nitro - dt / spec.nitroDuration);
  else car.nitro = Math.min(1, car.nitro + dt * spec.nitroRegen * (1 + Math.min(3, car.drift / 4)));

  const maxV = spec.maxSpeed * car.skill * (car.offroad ? 0.5 : 1) * (wantsNitro ? 1.28 : 1);

  // Longitudinal
  if (input.throttle > 0 && vF > -1) {
    const r = Math.max(0, vF) / maxV;
    vF += input.throttle * spec.engine * Math.max(0, 1 - r * r) * dt;
  }
  if (wantsNitro) vF += spec.nitroBoost * dt * (vF < maxV ? 1 : 0);
  if (vF > maxV) vF -= (vF - maxV) * 1.6 * dt;
  if (input.brake > 0) {
    if (vF > 0.5) vF = Math.max(0, vF - spec.brake * input.brake * dt);
    else vF = Math.max(-spec.reverseMax, vF - spec.engine * 0.6 * input.brake * dt);
  }
  vF -= vF * (0.12 + (car.offroad ? 0.9 : 0) + (input.handbrake ? 0.5 : 0)) * dt;
  if (!input.throttle && !input.brake && Math.abs(vF) < 0.3) vF = 0;

  // Steering / yaw
  const speedFactor = Math.min(1, Math.abs(vF) / spec.maxSpeed);
  const ramp = Math.min(1, Math.abs(vF) / 7);
  const omega = car.steer * spec.maxTurn * ramp * (1 - 0.5 * speedFactor) *
    (input.handbrake ? 1.4 : 1) * Math.sign(vF || 0);
  // velocity in world before rotating the chassis
  let vx = fx * vF + rx * vL, vz = fz * vF + rz * vL;
  car.heading -= omega * dt;
  fx = Math.sin(car.heading); fz = Math.cos(car.heading); rx = -fz; rz = fx;
  vF = vx * fx + vz * fz;
  vL = vx * rx + vz * rz;
  const grip = input.handbrake ? spec.driftGrip : car.offroad ? spec.grip * 0.55 : spec.grip;
  const keep = Math.exp(-grip * dt);
  // part of the scrubbed lateral speed is converted back to forward speed
  vF += Math.abs(vL) * (1 - keep) * 0.25 * Math.sign(vF || 1);
  vL *= keep;

  car.drift = Math.abs(vL);
  vx = fx * vF + rx * vL; vz = fz * vF + rz * vL;
  car.x += vx * dt; car.z += vz * dt;

  // Barrier collision
  car.wallImpact = 0;
  const loc = locate(track, car.x, car.z, loc0.i);
  const lim = WALL_DIST - 1.1;
  if (Math.abs(loc.lat) > lim) {
    const sgn = Math.sign(loc.lat);
    const sx = track.sx[loc.i] * sgn, sz = track.sz[loc.i] * sgn;
    const pen = Math.abs(loc.lat) - lim;
    car.x -= sx * pen; car.z -= sz * pen;
    const vn = vx * sx + vz * sz;
    if (vn > 0) {
      vx -= sx * vn * 1.35; vz -= sz * vn * 1.35;
      // friction scales with impact: glancing scrapes barely slow the car
      const keep = 1 - Math.min(0.35, vn * 0.025);
      vx *= keep; vz *= keep;
      car.wallImpact = vn;
    }
  }
  car.vx = vx; car.vz = vz;
  car.speed = vx * fx + vz * fz;
  car.wheelSpin += car.speed * dt / 0.36;

  // Progress / laps
  const prev = car.idx;
  const ni = loc.i;
  if (prev >= 0) {
    if (prev > N * 0.8 && ni < N * 0.2) car.lapCounter++;
    else if (prev < N * 0.2 && ni > N * 0.8) car.lapCounter--;
  }
  car.idx = ni;
  car.progressF = loc.f < 0 ? 0 : loc.f;
  car.lat = loc.lat;
  car.wrongWay = (fx * track.tx[ni] + fz * track.tz[ni]) < -0.2 && Math.abs(car.speed) > 3;
}

/** AI driver: pure-pursuit steering + speed table throttle control. */
export function aiInput(car, track, speedTable, cars, spec = SPEC) {
  const { N, ds } = track;
  const i = car.idx < 0 ? 0 : car.idx;
  const v = Math.max(0, car.speed);

  // racing line: drift toward the inside of upcoming corners
  const ahead = wrap(i + Math.round(35 / ds), N);
  let inside = clamp(-track.curv[ahead] * 260, -4.5, 4.5);

  // overtaking / avoidance
  let avoid = 0;
  for (const o of cars) {
    if (o === car) continue;
    let d = (o.progressF - car.progressF);
    if (d < -N / 2) d += N; if (d > N / 2) d -= N;
    const dist = d * ds;
    if (dist > 0 && dist < 18 && Math.abs(o.lat - car.lat) < 3.2) {
      avoid += (o.lat > car.lat ? -1 : 1) * 3.6 * (1 - dist / 18);
    }
  }
  car.avoid += (avoid - car.avoid) * 0.08;
  const offset = clamp(car.lane + inside + car.avoid, -ROAD_HALF + 1.8, ROAD_HALF - 1.8);

  const look = 9 + v * 0.42;
  const t = pointAt(track, car.progressF + look / ds, offset);
  const dx = t.x - car.x, dz = t.z - car.z;
  const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
  const lx = dx * -fz + dz * fx;       // right component
  const lz = dx * fx + dz * fz;        // forward component
  const ang = Math.atan2(lx, lz);
  const steer = clamp(ang * 2.4, -1, 1);

  const target = speedTable[wrap(i + 4, N)] * car.skill;
  let throttle = 0, brake = 0;
  if (v < target - 0.5) throttle = 1;
  else if (v < target + 1) throttle = 0.35;
  if (v > target + 2.5) brake = clamp((v - target) / 10, 0.2, 1);
  if (Math.abs(ang) > 1.2) { throttle = 0.6; }

  const straight = speedTable[wrap(i + Math.round(60 / ds), N)] >= spec.maxSpeed * 0.98 &&
    target >= spec.maxSpeed * 0.98;
  const nitro = straight && (car.nitroActive ? car.nitro > 0.05 : car.nitro > 0.55);
  return { throttle, brake, steer, handbrake: false, nitro };
}

/** Simple circle-vs-circle car collisions. Returns strongest impact speed. */
export function resolveCollisions(cars) {
  let strongest = 0;
  const minD = CAR_RADIUS * 2;
  for (let a = 0; a < cars.length; a++) {
    for (let b = a + 1; b < cars.length; b++) {
      const A = cars[a], B = cars[b];
      const dx = B.x - A.x, dz = B.z - A.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD || d2 === 0) continue;
      const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
      const pen = (minD - d) / 2;
      A.x -= nx * pen; A.z -= nz * pen; B.x += nx * pen; B.z += nz * pen;
      const rv = (B.vx - A.vx) * nx + (B.vz - A.vz) * nz;
      if (rv < 0) {
        const j = -rv * 0.75;
        A.vx -= nx * j; A.vz -= nz * j; B.vx += nx * j; B.vz += nz * j;
        if (A.isPlayer || B.isPlayer) strongest = Math.max(strongest, -rv);
      }
    }
  }
  return strongest;
}
