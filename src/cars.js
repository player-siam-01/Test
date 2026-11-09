// Car roster: each model changes the physics spec and the body proportions.
// The garage stats are MEASURED by running each spec through the physics
// model (not hand-typed numbers), so the bars always match how the car drives.
import { SPEC, Car, stepCar } from './physics.js';

export const CAR_MODELS = [
  {
    id: 'gt', name: 'Strada GT', tagline: 'Balanced all-rounder · easy to drive',
    spec: {},
    shape: { sx: 1, sy: 1, sz: 1, cabinY: 1, wing: true, wheel: 1 },
  },
  {
    id: 'vento', name: 'Vento R', tagline: 'Hypercar · fastest on the straights · twitchy',
    spec: { power: 560000, mass: 1300, mu: 1.26, downforce: 1.0, drag: 0.9, brakeG: 1.18, maxSteer: 0.5, inertia: 1650 },
    shape: { sx: 1.05, sy: 0.9, sz: 1.05, cabinY: 0.9, wing: true, wheel: 1.04 },
  },
  {
    id: 'brute', name: 'Brute V8', tagline: 'Muscle car · huge power · heavy, loves to slide',
    spec: { power: 600000, mass: 1550, mu: 1.22, downforce: 0.3, drag: 1.1, brakeG: 1.0, maxSteer: 0.55, rearDrive: 0.95, inertia: 2500 },
    shape: { sx: 1.03, sy: 1.1, sz: 1.08, cabinY: 1.05, wing: false, wheel: 1.05 },
  },
  {
    id: 'kei', name: 'Kei Sprint', tagline: 'Hot hatch · best in the corners · slow on straights',
    spec: { power: 240000, mass: 980, mu: 1.42, downforce: 0.25, drag: 0.95, brakeG: 1.22, maxSteer: 0.68, rearDrive: 0.0, inertia: 1100, a: 1.05, b: 1.25 },
    shape: { sx: 0.93, sy: 1.12, sz: 0.84, cabinY: 1.2, wing: false, wheel: 0.92 },
  },
];

export const modelById = (id) => CAR_MODELS.find((m) => m.id === id) || CAR_MODELS[0];
const specCache = new Map();
/** Full physics spec for a model (cached, so it can key per-model AI speed tables). */
export const specFor = (model) => {
  if (!specCache.has(model.id)) specCache.set(model.id, { ...SPEC, ...model.spec });
  return specCache.get(model.id);
};

/** Run the car through standard tests on an open field (no walls). */
function measure(spec, track) {
  const open = { ...track, open: true };
  const dt = 1 / 120;
  const mk = () => { const c = new Car({ id: 0, name: 't', color: 0 }); c.spec = spec; c.x = 0; c.z = -150; c.heading = 0; return c; };
  // 0-100 km/h
  let c = mk(), t = 0;
  while (c.speed < 100 / 3.6 && t < 20) { stepCar(c, { throttle: 1, brake: 0, steer: 0 }, open, dt, spec); t += dt; }
  const zeroTo100 = t;
  // top speed: power = drag * v^3 + rolling * v
  let v = 10;
  for (let i = 0; i < 60; i++) v = Math.cbrt(Math.max(1, spec.power - spec.rolling * v) / spec.drag);
  // braking 100-0
  c = mk(); c.vz = 100 / 3.6; c.speed = c.vz;
  const z0 = c.z; t = 0;
  while (c.speed > 0.3 && t < 10) { stepCar(c, { throttle: 0, brake: 1, steer: 0 }, open, dt, spec); t += dt; }
  const brake100 = c.z - z0;
  // cornering grip at 120 km/h, in g
  const u = 120 / 3.6;
  const grip = spec.mu * (9.81 + spec.downforce * u * u / spec.mass) / 9.81;
  return { topKmh: v * 3.6, zeroTo100, brake100, grip, agility: spec.maxSteer * 1250 / spec.mass };
}

/** Stats for every model, plus 1..10 bar values relative to the roster. */
export function rosterStats(track) {
  const raw = CAR_MODELS.map((m) => measure(specFor(m), track));
  const bar = (vals, higherBetter) => {
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return vals.map((x) => {
      const f = hi === lo ? 1 : (x - lo) / (hi - lo);
      return Math.round(3 + 7 * (higherBetter ? f : 1 - f));
    });
  };
  const top = bar(raw.map((r) => r.topKmh), true);
  const acc = bar(raw.map((r) => r.zeroTo100), false);
  const hand = bar(raw.map((r) => r.grip * 0.7 + r.agility * 0.3), true);
  const brk = bar(raw.map((r) => r.brake100), false);
  return CAR_MODELS.map((m, i) => ({
    id: m.id,
    raw: raw[i],
    bars: { speed: top[i], accel: acc[i], handling: hand[i], braking: brk[i] },
  }));
}
