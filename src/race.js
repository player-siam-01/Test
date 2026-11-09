// Race manager: grid, countdown, laps, positions, results. Pure logic.
import { createTrack, pointAt } from './track.js';
import { Car, SPEC, stepCar, aiInput, buildSpeedTable, resolveCollisions } from './physics.js';

export const DIFFICULTY = {
  easy: { skill: [0.8, 0.83, 0.86], label: 'Easy' },
  normal: { skill: [0.9, 0.93, 0.96], label: 'Normal' },
  hard: { skill: [0.98, 1.0, 1.02], label: 'Hard' },
};

const RIVALS = [
  { name: 'VIPER', color: 0x22e0ff },
  { name: 'BLAZE', color: 0xff8a1f },
  { name: 'NOVA', color: 0x9dff3a },
];

export const FIXED_DT = 1 / 120;
const COUNTDOWN = 3;

export class Race {
  constructor(track = createTrack()) {
    this.track = track;
    this.speedTable = buildSpeedTable(track);
    this.cars = [];
    this.state = 'idle';
    this.events = [];
  }

  setup({ laps = 3, difficulty = 'normal', mode = 'race', playerColor = 0xff2d6f, playerName = 'YOU' } = {}) {
    this.laps = laps;
    this.mode = mode;
    this.difficulty = difficulty;
    const skills = (DIFFICULTY[difficulty] || DIFFICULTY.normal).skill;
    this.cars = [
      new Car({ id: 0, name: playerName, color: playerColor, isPlayer: true }),
      ...(mode === 'trial' ? [] : RIVALS).map((r, k) => new Car({ id: k + 1, name: r.name, color: r.color, skill: skills[k], lane: [-2.5, 2.5, 0][k] })),
    ];
    // 2x2 staggered grid behind the start line; player starts last-but-one
    const order = mode === 'trial' ? [null, null, this.cars[0]] : [this.cars[1], this.cars[2], this.cars[0], this.cars[3]];
    const { N, ds } = this.track;
    order.forEach((car, k) => {
      if (!car) return;
      const back = 10 + k * 7;
      const p = pointAt(this.track, N - back / ds, k % 2 === 0 ? -3.5 : 3.5);
      car.x = p.x; car.z = p.z; car.heading = p.heading;
      car.idx = -1; car.lapCounter = -1;
    });
    this.time = 0;          // race clock (starts at GO)
    this.countdown = COUNTDOWN;
    this.state = 'countdown';
    this.finishOrder = [];
    this.events = [];
    this._lastBeep = 4;
    this._acc = 0;
    // settle idx so lap logic starts clean
    for (const c of this.cars) stepCar(c, { throttle: 0, brake: 1, steer: 0 }, this.track, 0);
    this.savePoses();
  }

  get player() { return this.cars[0]; }

  /** Cars sorted by race position. */
  standings() {
    return [...this.cars].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
  }

  positionOf(car) { return this.standings().indexOf(car) + 1; }

  /** Advance by real elapsed time using fixed sub-steps. */
  update(dt, playerInput, { autopilot = false } = {}) {
    this._acc += Math.min(dt, 0.25);
    let steps = 0;
    while (this._acc >= FIXED_DT) {
      this.step(FIXED_DT, playerInput, autopilot);
      this._acc -= FIXED_DT;
      steps++;
    }
    return steps;
  }

  /** Fraction of a physics step left over after update(): used to interpolate rendering. */
  get alpha() { return Math.min(1, this._acc / FIXED_DT); }

  /** Remember each car's pose before a physics step (for smooth rendering). */
  savePoses() {
    for (const c of this.cars) { c.x0 = c.x; c.z0 = c.z; c.h0 = c.heading; c.w0 = c.wheelSpin; }
  }

  step(dt, playerInput, autopilot) {
    this.savePoses();
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n < this._lastBeep && n > 0) { this._lastBeep = n; this.events.push({ type: 'beep', n }); }
      if (this.countdown <= 0) {
        this.state = 'racing';
        this.time = 0;
        for (const c of this.cars) c.lapStart = 0;
        this.events.push({ type: 'go' });
      }
      return;
    }
    if (this.state !== 'racing' && this.state !== 'finished') return;
    this.time += dt;

    let impact = 0;
    for (const car of this.cars) {
      let input;
      if (car.isPlayer && !autopilot && !car.finished) input = playerInput;
      else {
        input = aiInput(car, this.track, this.speedTable, this.cars);
        if (car.finished) { input.throttle *= 0.5; input.nitro = false; }
      }
      const before = car.lapCounter;
      stepCar(car, input, this.track, dt);
      if (car.isPlayer && car.wallImpact > 2) impact = Math.max(impact, car.wallImpact);
      if (car.lapCounter > before && before >= 0 && !car.finished) this.onLap(car);
    }
    const ci = resolveCollisions(this.cars);
    if (ci > 2) this.events.push({ type: 'carHit', strength: ci });
    if (impact) this.events.push({ type: 'wallHit', strength: impact });
  }

  onLap(car) {
    const lt = this.time - car.lapStart;
    car.lapTimes.push(lt);
    car.lapStart = this.time;
    if (car.lapCounter >= this.laps) {
      car.finished = true;
      car.finishTime = this.time;
      this.finishOrder.push(car);
      if (car.isPlayer) {
        this.state = 'finished';
        this.events.push({ type: 'finish', position: this.finishOrder.length, time: this.time });
      }
    } else if (car.isPlayer) {
      this.events.push({ type: 'lap', lap: car.lapCounter + 1, time: lt, final: car.lapCounter === this.laps - 1 });
    }
  }

  /** Put a stuck car back on the racing line, facing forward. */
  respawn(car = this.player) {
    const p = pointAt(this.track, Math.max(0, car.progressF), 0);
    car.x = p.x; car.z = p.z; car.heading = p.heading;
    car.vx = car.vz = car.speed = 0;
    car.x0 = car.x; car.z0 = car.z; car.h0 = car.heading;
  }

  drainEvents() { const e = this.events; this.events = []; return e; }
}

export { SPEC };
