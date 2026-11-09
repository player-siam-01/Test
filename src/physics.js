// Arcade car physics + AI driver. Pure logic: runs identically in the render
// loop and in the headless fixed-step simulation used by the E2E tests.
import { ROAD_HALF, CURB_WIDTH, WALL_DIST, locate, pointAt, wrap } from './track.js';

// Vehicle model: a "bicycle" (single-track) model with non-linear tyres,
// load transfer, downforce, AWD with a rear bias, and a light stability assist.
// Numbers are roughly those of a modern AWD supercar.
export const SPEC = {
  mass: 1250,          // kg
  inertia: 1750,       // yaw inertia, kg m^2
  a: 1.2, b: 1.4,      // CG to front / rear axle, m
  cgHeight: 0.38,      // m (longitudinal load transfer)
  rearGrip: 1.1,       // wider rear tyres: keeps the car stable on the brakes
  mu: 1.35,            // tyre friction (sport semi-slicks)
  cf: 95000, cr: 125000, // cornering stiffness, N/rad (front softer = mild understeer)
  power: 420000,       // W
  drag: 1.13,          // aero drag factor, N/(m/s)^2  -> ~255 km/h top speed
  rolling: 250,        // N
  rearDrive: 0.65,     // share of drive torque to the rear axle (power oversteer)
  brakeG: 1.15,        // braking, in g
  downforce: 0.55,     // N/(m/s)^2
  maxSteer: 0.6,       // rad at walking pace (reduced with speed)
  reverseMax: 14,
  nitroForce: 7000,    // N
  nitroDuration: 3.2,  // seconds for a full tank
  nitroRegen: 1 / 16,  // tank per second
  maxSpeed: 71,        // approx. top speed without nitro, m/s (camera/HUD scaling)
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

/** Speed the AI can carry at every sample (grip + downforce limit), with a braking back-pass. */
export function buildSpeedTable(track, spec = SPEC) {
  const { N, ds } = track;
  const raw = new Float32Array(N);
  const g = 9.81;
  for (let i = 0; i < N; i++) {
    let c = 0;
    for (let k = -6; k <= 6; k++) c = Math.max(c, Math.abs(track.curv[wrap(i + k, N)]));
    const R = c > 1e-5 ? 1 / c : 1e5;
    let v = 8;
    for (let t = 8; t <= spec.maxSpeed * 1.25; t += 0.5) {
      const aLat = spec.mu * (g + spec.downforce * t * t / spec.mass);
      if (t * t <= 0.9 * aLat * R) v = t; else break;
    }
    raw[i] = v;
  }
  const decel = spec.brakeG * g * 0.7; // AI finishes most braking before turning in
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
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

export function stepCar(car, input, track, dt, spec = car.spec || SPEC) {
  car.steer += (input.steer - car.steer) * Math.min(1, dt * 8);
  car.throttle = input.throttle;
  car.braking = input.brake > 0.1;
  const N = track.N;

  const loc0 = locate(track, car.x, car.z, car.idx);
  car.offroad = !track.open && Math.abs(loc0.lat) > ROAD_HALF + CURB_WIDTH * 0.7; // track.open: test-only open field

  let fx = Math.sin(car.heading), fz = Math.cos(car.heading);
  // body-frame velocity: u forward, v to the LEFT; r = yaw rate (+ = turning left)
  let u = car.vx * fx + car.vz * fz;
  let v = car.vx * fz - car.vz * fx;
  let r = car.yawRate || 0;

  // Nitro
  const wantsNitro = input.nitro && car.nitro > 0.02 && u > 5;
  car.nitroActive = wantsNitro;
  if (wantsNitro) car.nitro = Math.max(0, car.nitro - dt / spec.nitroDuration);
  else car.nitro = Math.min(1, car.nitro + dt * spec.nitroRegen * (1 + Math.min(3, car.drift / 4)));

  const g = 9.81, m = spec.mass, A = spec.a, B = spec.b, L = A + B;
  const mu = spec.mu * (car.offroad ? 0.65 : 1) * (0.92 + 0.08 * car.skill);
  const power = spec.power * car.skill ** 3;
  const SUB = 2, h = dt / SUB;
  let delta = 0;
  for (let sIdx = 0; sIdx < SUB; sIdx++) {
    const au = Math.abs(u);
    const df = spec.downforce * u * u;
    const ax = car.ax || 0;
    const Fzf = Math.max(0, m * g * B / L - m * ax * spec.cgHeight / L + df * 0.45);
    const Fzr = Math.max(0, m * g * A / L + m * ax * spec.cgHeight / L + df * 0.55);
    // speed-sensitive steering that tops out a little past the grip limit
    const aLat = mu * (Fzf + Fzr) / m;
    const dGrip = au > 1 ? Math.atan(L * aLat / (au * au)) + 0.05 : spec.maxSteer;
    const dMax = Math.min(spec.maxSteer / (1 + au / 12), dGrip * 1.3);
    delta = -car.steer * dMax; // + = left

    // drive, brakes, resistance
    let Fdrive = 0;
    if (input.throttle > 0 && u > -0.5) {
      // traction control: leave enough of the friction circle for the cornering in progress
      const latUse = Math.min(0.97, Math.abs(u * r) / Math.max(aLat, 1));
      const tc = input.handbrake ? 1 : Math.sqrt(1 - latUse * latUse);
      // traction limit per DRIVEN axle (a RWD car can only use the rear tyres' grip, FWD the front)
      const rs = spec.rearDrive, fs = 1 - rs;
      const capDrive = Math.min(rs > 0.01 ? mu * spec.rearGrip * Fzr * 0.95 / rs : Infinity, fs > 0.01 ? mu * Fzf * 0.95 / fs : Infinity);
      Fdrive = input.throttle * Math.min(capDrive * Math.max(0.15, tc), power / Math.max(au, 3));
    }
    if (wantsNitro) Fdrive += spec.nitroForce;
    let Fbrake = 0;
    if (input.brake > 0) {
      if (u > 0.5) Fbrake = input.brake * spec.brakeG * m * g * (car.offroad ? 0.7 : 1);
      else if (u > -spec.reverseMax) Fdrive -= input.brake * m * 5; // reverse gear
    }
    let Fhb = 0;
    if (input.handbrake && au > 0.5) Fhb = 0.3 * mu * Fzr;
    const sgnU = Math.sign(u) || 0;
    // 70/30 brake bias; rear brake force is ABS-limited so it never locks the rear
    const FbR = Math.min(Fbrake * 0.3, 0.55 * mu * Fzr);
    const FxF = Fdrive * (1 - spec.rearDrive) - (Fbrake - FbR) * sgnU;
    const FxR = Fdrive * spec.rearDrive - FbR * sgnU - Fhb * sgnU;
    const resist = spec.drag * u * au + spec.rolling * sgnU + (car.offroad ? m * 2.2 * sgnU : 0);

    // tyre lateral forces, limited by the friction circle left over after drive/brake
    const capF = Math.max(0.12 * mu * Fzf, Math.sqrt(Math.max(0, (mu * Fzf) ** 2 - FxF * FxF)));
    const muR = mu * spec.rearGrip;
    const capR = Math.max(0.12 * muR * Fzr, Math.sqrt(Math.max(0, (muR * Fzr) ** 2 - FxR * FxR))) * (input.handbrake ? 0.35 + 0.3 * Math.min(1, au / 45) : 1); // gentler at speed
    const k = u > 0 ? smoothstep(1.5, 5, u) : 0; // blend to a kinematic model at walking pace / reverse
    let FyF = 0, FyR = 0;
    if (k > 0) {
      const alphaF = delta - Math.atan2(v + A * r, au);
      const alphaR = -Math.atan2(v - B * r, au);
      FyF = capF * Math.tanh(spec.cf * alphaF / capF);
      FyR = capR * Math.tanh(spec.cr * alphaR / capR);
    }
    const cd = Math.cos(delta), sd = Math.sin(delta);
    let du = (FxF * cd - FyF * sd + FxR - resist) / m + v * r;
    let dv = (FyF * cd + FxF * sd + FyR) / m - u * r;
    let dr = (A * (FyF * cd + FxF * sd) - B * FyR) / spec.inertia;
    // stability assist (off while the handbrake is held, so drifts stay possible)
    if (k > 0 && !input.handbrake) {
      const rT = clamp(u * Math.tan(delta) / L, -aLat / Math.max(au, 1), aLat / Math.max(au, 1));
      const err = rT - r;
      dr += err * (1.6 + Math.min(4, Math.abs(err) * 3)) * k; // stronger the further it rotates past the target
      const beta = Math.atan2(Math.abs(v), au);
      if (beta > 0.2) dv -= v * 2.5 * k;
    }
    const uPrev = u;
    u += du * h; v += dv * h; r += dr * h;
    if (Fbrake > 0 && uPrev > 0 && u < 0) u = 0; // brakes stop the car, they don't reverse it
    if (k < 1) { // low speed: kinematic steering, no sliding
      const rK = u * Math.tan(delta) / L;
      r = r * k + rK * (1 - k);
      v *= k;
    }
    car.ax = (car.ax || 0) + (du - (car.ax || 0)) * 0.25;
    car.heading += r * h;
  }
  if (!input.throttle && !input.brake && Math.abs(u) < 0.3) u = 0;
  car.yawRate = r;
  car.steerAngle = delta;
  car.drift = Math.abs(v);
  fx = Math.sin(car.heading); fz = Math.cos(car.heading);
  let vx = fx * u + fz * v, vz = fz * u - fx * v;
  car.x += vx * dt; car.z += vz * dt;

  // Barrier collision
  car.wallImpact = 0;
  const loc = locate(track, car.x, car.z, loc0.i);
  const lim = WALL_DIST - 1.1;
  if (!track.open && Math.abs(loc.lat) > lim) {
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
      car.yawRate = (car.yawRate || 0) * 0.6;
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
export function aiInput(car, track, speedTable, cars, spec = car.spec || SPEC, dt = 1 / 120) {
  const { N, ds } = track;
  const i = car.idx < 0 ? 0 : car.idx;
  const v = Math.max(0, car.speed);

  // stuck recovery: after a spin into the wall, back out with opposite lock
  if (car.reverseTimer > 0) {
    car.reverseTimer -= dt;
    const tx = track.tx[i], tz = track.tz[i];
    const cross = Math.sin(car.heading) * tz - Math.cos(car.heading) * tx; // >0: pointing left of the track
    return { throttle: 0, brake: 1, steer: cross > 0 ? -1 : 1, handbrake: false, nitro: false };
  }
  if (Math.abs(car.speed) < 2) car.stuckTime = (car.stuckTime || 0) + dt; else car.stuckTime = 0;
  if (car.stuckTime > 1.2) { car.stuckTime = 0; car.reverseTimer = 1.1; car.stuckCount = (car.stuckCount || 0) + 1; }

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
  // aim along the direction of travel (not the nose), so body slip doesn't fool the driver
  const sp = Math.hypot(car.vx, car.vz);
  const dirH = sp > 3 ? Math.atan2(car.vx, car.vz) : car.heading;
  const fx = Math.sin(dirH), fz = Math.cos(dirH);
  const lx = dx * -fz + dz * fx;       // right component
  const lz = dx * fx + dz * fz;        // forward component
  const ang = Math.atan2(lx, lz);
  // proportional steering + yaw-rate damping (counter-steer when rotating too fast)
  const steer = clamp(ang * 1.6 + (car.yawRate || 0) * 0.18, -1, 1);

  const target = speedTable[wrap(i + 4, N)] * Math.min(1, car.skill);
  let throttle = 0, brake = 0;
  // ease off while the car is still sliding (lets the tyres hook up again)
  const slide = Math.min(1, Math.max(0, (car.drift - 2) / 4));
  if (v < target - 0.5) throttle = 1 - 0.6 * slide;
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
