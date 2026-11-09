// Neon Velocity — rendering, input, UI and game loop.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GradeShader } from './post.js';
import { Race, FIXED_DT } from './race.js';
import { SPEC } from './physics.js';
import { buildWorld } from './world.js';
import { buildCar } from './carModel.js';
import { Particles, SkidMarks } from './effects.js';
import { AudioFX } from './audio.js';
import { Speedometer, Minimap } from './hud.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// real-world paint colours: racing red, silver, deep blue, pearl white, black, British green
const COLORS = [0xc8102e, 0xb8bcc2, 0x1e3f8a, 0xeeeeea, 0x16171a, 0x1f4d2b];
// phones and tablets start in the lighter graphics mode; computers in High
const coarsePointer = matchMedia('(pointer: coarse)').matches;
const settings = Object.assign({ color: COLORS[0], difficulty: 'normal', laps: 3, mode: 'race', quality: coarsePointer ? 'low' : 'high' },
  store.get('nv-settings', {}));
if (params.get('quality')) settings.quality = params.get('quality');
if (params.get('laps')) settings.laps = +params.get('laps');
if (!COLORS.includes(settings.color)) settings.color = COLORS[0]; // saved colour from an older version
let best = store.get('nv-best', {}); // { lap: seconds, ['race'+laps]: seconds }

const fmt = (t) => {
  if (t == null || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

// ---------------------------------------------------------------- renderer
const canvas = $('game');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  $('loading').classList.add('hidden');
  $('error').classList.remove('hidden');
  throw e;
}
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 7000);
const race = new Race();
race.setup(settings);
const world = buildWorld(scene, renderer, race.track);

const carViews = race.cars.map((c) => {
  const v = buildCar(c.color);
  scene.add(v.group);
  return v;
});
// player headlights
const headlight = new THREE.SpotLight(0xfff1dd, 60, 70, 0.5, 0.6, 1.6);
headlight.position.set(0, 0.8, 1.8);
headlight.target.position.set(0, 0, 18);
carViews[0].group.add(headlight, headlight.target);

const smoke = new Particles(900, { drag: 1.1, grow: 3.2 });
const sparks = new Particles(400, { additive: true, gravity: 12, drag: 0.6, grow: -0.7 });
const skids = new SkidMarks(1600);
scene.add(smoke.points, sparks.points, skids.mesh);

// HDR target with 4x MSAA: removes the jagged "pixel" edges
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.18, 0.5, 0.95);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const grade = new ShaderPass(GradeShader);
composer.addPass(grade);

// autoLevel 0..4: extra savings applied automatically when the device can't keep up
let autoLevel = 0;
const AUTO_SCALE = [1, 0.8, 0.66, 0.66, 0.55];
function applyQuality() {
  const high = settings.quality === 'high';
  // never render below 1.5x on high-DPI phones unless we must: 1x looks blocky on a 3x screen
  const base = Math.min(high ? 2 : 1.5, window.devicePixelRatio || 1);
  renderer.setPixelRatio(Math.max(0.6, base * AUTO_SCALE[autoLevel]));
  bloom.enabled = autoLevel < 4;
  bloom.strength = high ? 0.18 : 0.14; // daylight: just a hint of glare on highlights
  // MSAA is the costliest part on weak GPUs: 4x on High, off in Performance mode
  const samples = high && autoLevel < 2 ? 4 : 0;
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
    if (rt.samples !== samples) { rt.samples = samples; rt.dispose(); }
  }
  const shadows = high && autoLevel < 3;
  world.sun.castShadow = shadows;
  renderer.shadowMap.enabled = shadows;
  resize();
}

/**
 * Watches the real frame rate in ~2.5 s windows. Below 48 FPS it steps the
 * render cost down one level; if a step doesn't help (e.g. the phone is capped
 * at 30 FPS by battery saver) adaptation stops going down.
 * Sustained 58+ FPS lets it step back up.
 */
const perf = { t: 0, n: 0, goodWindows: 0, floor: 0, lastDownFps: null, cooldown: 1.5 };
function adaptQuality(realDt) {
  if (params.has('noauto')) return; // fixed quality (screenshots / tests)
  if (realDt > 2 || document.hidden) return; // ignore app-switch pauses, not slow frames
  if (perf.cooldown > 0) { perf.cooldown -= realDt; return; }
  perf.t += realDt; perf.n++;
  if (perf.t < 2.5 || perf.n < 5) return;
  const fps = perf.n / perf.t;
  perf.t = 0; perf.n = 0;
  if (perf.lastDownFps != null) {
    const before = perf.lastDownFps;
    perf.lastDownFps = null;
    // no real gain (e.g. phone capped at 30 FPS by battery saver): keep this step
    // but stop lowering further, so we never sacrifice quality for nothing
    if (fps < before * 1.1) { perf.floor = 99; return; }
  }
  if (fps < 48 && autoLevel < 4 && perf.floor !== 99) {
    perf.lastDownFps = fps;
    autoLevel++; perf.goodWindows = 0; applyQuality(); perf.cooldown = 1.5;
  } else if (fps > 58 && autoLevel > 0) {
    if (++perf.goodWindows >= 3) { autoLevel--; perf.goodWindows = 0; applyQuality(); perf.cooldown = 1.5; }
  } else perf.goodWindows = 0;
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  updateParticleScale();
}
function updateParticleScale() {
  const h = renderer.domElement.height;
  const s = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  smoke.material.uniforms.scale.value = s;
  sparks.material.uniforms.scale.value = s;
}
window.addEventListener('resize', resize);

const audio = new AudioFX();
audio.muted = store.get('nv-muted', false);
const speedo = new Speedometer($('speedo'));
const minimap = new Minimap($('minimap'), race.track);

// ---------------------------------------------------------------- input
const keys = new Set();
const touch = { up: false, down: false, left: false, right: false, nitro: false, handbrake: false };
const KEYMAP = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right', Space: 'handbrake', ShiftLeft: 'nitro', ShiftRight: 'nitro', KeyN: 'nitro',
};
window.addEventListener('keydown', (e) => {
  const k = KEYMAP[e.code];
  if (k) { keys.add(k); e.preventDefault(); }
  if (e.repeat) return;
  if (e.code === 'KeyC') cycleCamera();
  else if (e.code === 'KeyM') toggleMute();
  else if (e.code === 'KeyR' && ui === 'race' && race.state === 'racing') race.respawn();
  else if (e.code === 'KeyP' || e.code === 'Escape') {
    if (ui === 'race') setPaused(true); else if (ui === 'paused') setPaused(false);
  } else if (e.code === 'Enter' && ui === 'menu') startRace();
});
window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys.delete(k); });
window.addEventListener('blur', () => keys.clear());

for (const btn of document.querySelectorAll('.tbtn')) {
  const k = btn.dataset.k;
  const on = (e) => { e.preventDefault(); touch[k] = true; btn.classList.add('on'); try { btn.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
  const off = (e) => { e.preventDefault(); touch[k] = false; btn.classList.remove('on'); };
  btn.addEventListener('pointerdown', on);
  btn.addEventListener('pointerup', off);
  btn.addEventListener('pointercancel', off);
  btn.addEventListener('lostpointercapture', off);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
const isTouch = params.has('touch') || coarsePointer;
if (isTouch) document.body.classList.add('touch');

function readInput() {
  const has = (k) => keys.has(k) || touch[k];
  const inp = {
    throttle: has('up') ? 1 : 0,
    brake: has('down') ? 1 : 0,
    steer: (has('right') ? 1 : 0) - (has('left') ? 1 : 0),
    handbrake: has('handbrake'),
    nitro: has('nitro'),
  };
  const pad = navigator.getGamepads?.()[0];
  if (pad) {
    const ax = pad.axes[0] || 0;
    if (Math.abs(ax) > 0.15) inp.steer = ax;
    inp.throttle = Math.max(inp.throttle, pad.buttons[7]?.value || 0);
    inp.brake = Math.max(inp.brake, pad.buttons[6]?.value || 0);
    inp.nitro ||= !!pad.buttons[0]?.pressed;
    inp.handbrake ||= !!pad.buttons[1]?.pressed;
  }
  return inp;
}

// ---------------------------------------------------------------- UI
let ui = 'menu';
const CAMERAS = ['chase', 'far', 'hood'];
let camMode = 0;
function cycleCamera() { camMode = (camMode + 1) % CAMERAS.length; if (ui === 'race') banner(CAMERAS[camMode].toUpperCase() + ' CAM', '', 900); }
function toggleMute() {
  audio.setMuted(!audio.muted);
  store.set('nv-muted', audio.muted);
  $('mute-btn').textContent = `Sound: ${audio.muted ? 'Off' : 'On'}`;
}
$('mute-btn').textContent = `Sound: ${audio.muted ? 'Off' : 'On'}`;

function setPressed(groupEl, value) {
  for (const b of groupEl.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === String(value)));
}
const sw = $('swatches');
for (const c of COLORS) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.dataset.v = String(c);
  b.style.background = '#' + c.toString(16).padStart(6, '0');
  b.style.color = b.style.background;
  b.setAttribute('aria-label', 'Paint #' + c.toString(16).padStart(6, '0'));
  b.addEventListener('click', () => { settings.color = c; setPressed(sw, c); carViews[0].setColor(c); race.player.color = c; saveSettings(); });
  sw.appendChild(b);
}
for (const [id, key, conv] of [['mode', 'mode', String], ['difficulty', 'difficulty', String], ['laps', 'laps', Number], ['quality', 'quality', String]]) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    settings[key] = conv(b.dataset.v);
    setPressed(el, settings[key]);
    if (key === 'quality') { autoLevel = 0; perf.floor = 0; perf.lastDownFps = null; applyQuality(); }
    saveSettings();
    updateBestLabel();
  });
}
function syncCarViews() {
  carViews.forEach((v, i) => {
    const c = race.cars[i];
    v.group.visible = !!c;
    if (c) v.setColor(c.color);
  });
}
const bestKey = () => (race.mode === 'trial' ? 'trial' : 'race') + race.laps;
function saveSettings() { store.set('nv-settings', settings); }
function syncMenu() {
  setPressed(sw, settings.color); setPressed($('mode'), settings.mode); setPressed($('difficulty'), settings.difficulty);
  setPressed($('laps'), settings.laps); setPressed($('quality'), settings.quality);
  syncCarViews();
  carViews[0].setColor(settings.color);
  updateBestLabel();
}
function updateBestLabel() {
  const parts = [];
  if (best.lap) parts.push(`BEST LAP ${fmt(best.lap)}`);
  const k = (settings.mode === 'trial' ? 'trial' : 'race') + settings.laps;
  if (best[k]) parts.push(`BEST ${settings.laps}-LAP ${settings.mode === 'trial' ? 'TRIAL' : 'RACE'} ${fmt(best[k])}`);
  $('best-label').textContent = parts.join('  ·  ');
}

let bannerTimer;
function banner(text, cls = '', ms = 1600) {
  const b = $('banner');
  b.textContent = text; b.className = 'show ' + cls;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.className = cls; }, ms);
}

function show(id, on) { $(id).classList.toggle('hidden', !on); }

function startRace() {
  audio.init();
  audio.setMuted(audio.muted);
  race.setup({ ...settings, playerColor: settings.color });
  syncCarViews();
  skids.clear();
  ui = 'race';
  show('menu', false); show('results', false); show('pause', false);
  show('hud', true); show('touch', isTouch);
  snapCamera = true;
  lastCount = null;
  resultsShown = false;
}
function setPaused(p) {
  if (p && ui === 'race') { ui = 'paused'; show('pause', true); keys.clear(); }
  else if (!p && ui === 'paused') { ui = race.state === 'finished' ? 'results' : 'race'; show('pause', false); }
}
function toMenu() {
  ui = 'menu';
  race.setup({ ...settings, playerColor: settings.color });
  syncCarViews();
  skids.clear();
  show('pause', false); show('results', false); show('hud', false); show('touch', false); show('menu', true);
  syncMenu();
}
$('start-btn').addEventListener('click', startRace);
$('resume-btn').addEventListener('click', () => setPaused(false));
$('restart-btn').addEventListener('click', startRace);
$('quit-btn').addEventListener('click', toMenu);
$('again-btn').addEventListener('click', startRace);
$('menu-btn').addEventListener('click', toMenu);
$('pause-btn').addEventListener('click', () => setPaused(true));
document.addEventListener('visibilitychange', () => { if (document.hidden && ui === 'race') setPaused(true); });

let resultsShown = false;
function renderResults() {
  const p = race.player;
  const pos = race.finishOrder.indexOf(p) + 1;
  $('res-title').textContent = race.mode === 'trial' ? 'TIME TRIAL' : pos === 1 ? 'VICTORY!' : `${ordinal(pos).toUpperCase()} PLACE`;
  const bl = p.lapTimes.length ? Math.min(...p.lapTimes) : null;
  $('res-sub').textContent = `Total ${fmt(p.finishTime)} · Best lap ${fmt(bl)}`;
  $('res-body').innerHTML = race.standings().map((c, i) => {
    const b = c.lapTimes.length ? Math.min(...c.lapTimes) : null;
    const t = c.finished ? fmt(c.finishTime) : 'Racing…';
    const col = '#' + c.color.toString(16).padStart(6, '0');
    return `<tr class="${c.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td><span style="color:${col}">●</span> ${c.name}</td><td>${fmt(b)}</td><td>${t}</td></tr>`;
  }).join('');
}

// ---------------------------------------------------------------- events
let shake = 0;
function handleEvents(events) {
  for (const e of events) {
    if (e.type === 'beep') audio.beep(520, 0.2);
    else if (e.type === 'go') { audio.beep(1040, 0.5, 0.35); }
    else if (e.type === 'lap') {
      const isBest = !best.lap || e.time < best.lap;
      if (isBest) { best.lap = e.time; store.set('nv-best', best); }
      banner(e.final ? 'FINAL LAP' : `LAP ${e.lap}`, '', 1800);
      setTimeout(() => ui === 'race' && banner(`${isBest ? 'NEW BEST ' : ''}${fmt(e.time)}`, '', 1400), 1800);
    } else if (e.type === 'finish') {
      const p = race.player;
      const lastLap = p.lapTimes[p.lapTimes.length - 1];
      if (!best.lap || lastLap < best.lap) best.lap = lastLap;
      const key = bestKey();
      if (!best[key] || e.time < best[key]) best[key] = e.time;
      store.set('nv-best', best);
      banner(race.mode !== 'trial' && e.position === 1 ? 'WINNER!' : 'FINISH', '', 2200);
      audio.beep(660, 0.25); setTimeout(() => audio.beep(990, 0.45), 220);
      setTimeout(() => { if (ui === 'race' || ui === 'results') { ui = 'results'; resultsShown = true; renderResults(); show('results', true); show('touch', false); } }, 1500);
    } else if (e.type === 'wallHit' || e.type === 'carHit') {
      audio.crash(e.strength);
      shake = Math.min(1, shake + e.strength / 25);
      const p = race.player;
      const side = e.type === 'wallHit' ? Math.sign(p.lat) : 0;
      const sx = race.track.sx[p.idx] * side * 1.1, sz = race.track.sz[p.idx] * side * 1.1;
      for (let k = 0; k < 10 + e.strength * 2; k++) {
        sparks.emit(p.x + sx, 0.6, p.z + sz, (Math.random() - 0.5) * 14 + p.vx * 0.5, Math.random() * 7,
          (Math.random() - 0.5) * 14 + p.vz * 0.5, 0.35 + Math.random() * 0.4, 0.22, 6, 2.6, 0.6);
      }
    }
  }
}

// ---------------------------------------------------------------- camera
const camState = { pos: new THREE.Vector3(), look: new THREE.Vector3(), heading: 0, fov: 62 };
let snapCamera = true;
function updateCamera(dt, t) {
  const p0 = race.player;
  const p = { x: p0.rx ?? p0.x, z: p0.rz ?? p0.z, heading: p0.rh ?? p0.heading, speed: p0.speed, nitroActive: p0.nitroActive };
  if (ui === 'menu') {
    const a = t * 0.22 + 0.6;
    const target = new THREE.Vector3(p.x, 0.9, p.z);
    camera.position.set(p.x + Math.sin(a) * 8.5, 2.6 + Math.sin(t * 0.5) * 0.5, p.z + Math.cos(a) * 8.5);
    camera.lookAt(target);
    camera.fov = camera.aspect < 1 ? 74 : 50; camera.updateProjectionMatrix(); updateParticleScale();
    snapCamera = true;
    return;
  }
  let dh = p.heading - camState.heading;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  camState.heading += dh * Math.min(1, dt * 5);
  // never lag more than ~25 degrees behind the car (keeps it framed at low FPS)
  dh = p.heading - camState.heading;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  if (Math.abs(dh) > 0.45) camState.heading = p.heading - Math.sign(dh) * 0.45;
  if (snapCamera) camState.heading = p.heading;
  const fx = Math.sin(camState.heading), fz = Math.cos(camState.heading);
  const mode = CAMERAS[camMode];
  const desired = new THREE.Vector3(), look = new THREE.Vector3();
  if (mode === 'hood') {
    desired.set(p.x + Math.sin(p.heading) * 0.2, 1.42, p.z + Math.cos(p.heading) * 0.2);
    look.set(p.x + Math.sin(p.heading) * 30, 1.0, p.z + Math.cos(p.heading) * 30);
    camState.pos.copy(desired); camState.look.copy(look);
  } else {
    const dist = mode === 'far' ? 12.5 : 7.4, h = mode === 'far' ? 4.6 : 2.55;
    // speed pulls the camera back a little; height eases for a smooth ride
    const pull = Math.min(1.5, Math.abs(p.speed) / 40);
    camState.h = snapCamera || camState.h == null ? h : camState.h + (h - camState.h) * Math.min(1, dt * 3);
    desired.set(p.x - fx * (dist + pull), camState.h, p.z - fz * (dist + pull));
    look.set(p.x + fx * 4, 1.1, p.z + fz * 4);
    camState.pos.copy(desired);
    camState.look.copy(look);
  }
  snapCamera = false;
  camera.position.copy(camState.pos);
  if (shake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shake * 0.6;
    camera.position.y += (Math.random() - 0.5) * shake * 0.4;
    shake *= Math.exp(-dt * 6);
  }
  camera.lookAt(camState.look);
  const speedK = Math.min(1.2, Math.abs(p.speed) / SPEC.maxSpeed);
  // portrait phones get a wider vertical FOV so the car doesn't fill the screen
  const baseFov = camera.aspect >= 1 ? 60 : Math.min(92, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(30)) / camera.aspect)) * 0.8);
  const fovT = baseFov + speedK * 12 + (p.nitroActive ? 8 : 0);
  grade.uniforms.uSpeed.value = Math.max(0, speedK - 0.35) * 1.1 + (p.nitroActive ? 0.5 : 0);
  camState.fov += (fovT - camState.fov) * Math.min(1, dt * 4);
  camera.fov = camState.fov;
  camera.updateProjectionMatrix();
  updateParticleScale();
}

// ---------------------------------------------------------------- per-frame visuals
const emitAcc = new Map();
function carEffects(car, view, dt) {
  const fx = Math.sin(car.heading), fz = Math.cos(car.heading), rx = -fz, rz = fx;
  const dCam = Math.hypot(car.x - camera.position.x, car.z - camera.position.z);
  const near = dCam < 160;
  const drifting = car.drift > 4.2 && Math.abs(car.speed) > 6;
  const burn = car.throttle > 0 && car.braking && Math.abs(car.speed) < 4; // burnout
  for (const s of [-1, 1]) {
    const wx = car.x + rx * 0.9 * s - fx * 1.38, wz = car.z + rz * 0.9 * s - fz * 1.38;
    const key = car.id * 2 + (s > 0 ? 1 : 0);
    if ((drifting || (car.braking && Math.abs(car.speed) > 22)) && !car.offroad) skids.add(key, wx, wz, Math.min(1, car.drift / 10));
    else skids.lift(key);
    if (!near) continue;
    let acc = (emitAcc.get(key) || 0);
    if ((drifting || burn) && !car.offroad) {
      acc += dt * (burn ? 40 : Math.min(45, car.drift * 4));
      while (acc > 1) {
        acc -= 1;
        const g = 0.42 + Math.random() * 0.16;
        smoke.emit(wx, 0.35, wz, (Math.random() - 0.5) * 2 + car.vx * 0.15, 0.8 + Math.random(), (Math.random() - 0.5) * 2 + car.vz * 0.15,
          1.1 + Math.random() * 0.8, 0.8, g, g, g * 1.02);
      }
    } else if (car.offroad && Math.abs(car.speed) > 6) {
      acc += dt * Math.min(30, Math.abs(car.speed));
      while (acc > 1) {
        acc -= 1;
        smoke.emit(wx, 0.3, wz, (Math.random() - 0.5) * 3, 0.6 + Math.random(), (Math.random() - 0.5) * 3, 0.9, 1.0, 0.32, 0.26, 0.2);
      }
    } else acc = 0;
    emitAcc.set(key, acc);
  }
  if (near && car.nitroActive) {
    for (const s of [-1, 1]) {
      sparks.emit(car.x + rx * 0.45 * s - fx * 2.5, 0.38, car.z + rz * 0.45 * s - fz * 2.5,
        -car.vx * 0.1 + (Math.random() - 0.5) * 2, Math.random() * 0.8, -car.vz * 0.1 + (Math.random() - 0.5) * 2,
        0.18, 0.35, 0.8, 1.4, 6);
    }
  }
  const lateralSign = Math.sign((car.vx * rx + car.vz * rz) || 0);
  car.driftSign = car.drift > 3 ? -lateralSign : 0;
  view.sync(car, dt, elapsed);
}

let lastCount = null;
let hudTick = 0;
// only touch the DOM when the text actually changed (avoids per-frame layout work)
const domCache = new Map();
function setHTML(id, html) {
  if (domCache.get(id) === html) return;
  domCache.set(id, html);
  $(id).innerHTML = html;
}

function updateHUD(dt) {
  const p = race.player;
  const standings = race.standings();
  const pos = standings.indexOf(p) + 1;
  setHTML('hud-pos', `${pos}<small>/${race.cars.length}</small>`);
  const lap = Math.min(race.laps, Math.max(1, p.lapCounter + 1));
  setHTML('hud-lap', p.finished ? 'FINISHED' : `LAP ${lap}/${race.laps}`);
  const curLap = race.state === 'racing' ? race.time - p.lapStart : 0;
  setHTML('hud-time', fmt(p.finished ? p.finishTime : race.time));
  const last = p.lapTimes.length ? p.lapTimes[p.lapTimes.length - 1] : null;
  const bl = p.lapTimes.length ? Math.min(...p.lapTimes) : null;
  setHTML('hud-laps', `LAP ${fmt(p.finished ? last : curLap)}<br>LAST ${fmt(last)}<br>BEST ${fmt(bl ?? best.lap)}`);
  hudTick -= dt;
  if (hudTick <= 0) {
    hudTick = 0.2;
    const leader = standings[0];
    setHTML('hud-board', standings.map((c, i) => {
      const col = '#' + c.color.toString(16).padStart(6, '0');
      let gap = 'LEADER';
      if (i > 0) {
        if (c.finished) gap = fmt(c.finishTime);
        else {
          const d = ((leader.lapCounter - c.lapCounter) * race.track.N + (leader.progressF - c.progressF)) * race.track.ds;
          gap = `+${Math.max(0, d).toFixed(0)}m`;
        }
      }
      return `<li class="${c.isPlayer ? 'me' : ''}"><b>${i + 1}</b><span class="dot" style="color:${col}"></span>${c.name}<span class="gap">${gap}</span></li>`;
    }).join(''));
    if (resultsShown) renderResults();
  }
  // countdown
  const cd = $('countdown');
  let txt = '';
  if (race.state === 'countdown') txt = String(Math.ceil(race.countdown));
  else if (race.state === 'racing' && race.time < 0.9) txt = 'GO!';
  if (txt !== lastCount) {
    cd.textContent = txt; cd.classList.remove('pop'); void cd.offsetWidth; if (txt) cd.classList.add('pop');
    lastCount = txt;
  }
  if (p.wrongWay && race.state === 'racing' && !$('banner').classList.contains('show')) banner('WRONG WAY', 'warn', 700);
  const kmh = Math.abs(p.speed) * 3.6;
  speedo.draw(kmh, p.nitro, p.nitroActive, gearLabel);
  minimap.draw(race.cars);
}

// ---------------------------------------------------------------- smooth motion
// Physics runs at a fixed 120 Hz; the screen refreshes at its own rate. Blending
// between the last two physics poses removes the stutter of uneven step counts.
function updateRenderPoses() {
  const a = race.alpha;
  for (const c of race.cars) {
    if (c.x0 === undefined) { c.rx = c.x; c.rz = c.z; c.rh = c.heading; c.rw = c.wheelSpin; continue; }
    c.rx = c.x0 + (c.x - c.x0) * a;
    c.rz = c.z0 + (c.z - c.z0) * a;
    let dh = c.heading - c.h0;
    if (dh > Math.PI) dh -= Math.PI * 2; else if (dh < -Math.PI) dh += Math.PI * 2;
    c.rh = c.h0 + dh * a;
    c.rw = c.w0 + (c.wheelSpin - c.w0) * a;
  }
}

// ---------------------------------------------------------------- loop
let last = performance.now(), elapsed = 0, frames = 0, fps = 60, fpsAcc = 0, fpsN = 0;
let gearLabel = 'N';
function frame(now) {
  const realDt = Math.max(0, (now - last) / 1000);
  const dt = Math.min(0.1, realDt);
  last = now; elapsed += dt; frames++;
  fpsAcc += realDt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  if (ui === 'race' || ui === 'menu') adaptQuality(realDt);

  const active = ui === 'race' || ui === 'results';
  if (active) {
    race.update(dt, readInput(), { autopilot: race.player.finished || testAutopilot });
    handleEvents(race.drainEvents());
  }
  const vdt = ui === 'paused' ? 0 : dt;
  updateRenderPoses();
  race.cars.forEach((c, i) => carEffects(c, carViews[i], vdt));
  smoke.update(vdt); sparks.update(vdt);
  updateCamera(dt, elapsed);
  const p = race.player;
  world.update(elapsed, p, camera.position);
  world.setStartLights(ui === 'menu' ? 0 : race.state === 'countdown' ? Math.max(0, 4 - Math.ceil(race.countdown)) : race.time < 2 ? 4 : 0);
  if (ui !== 'menu') updateHUD(dt);
  const g = audio.update({ speed: p.speed, throttle: p.throttle, drift: p.drift, nitro: p.nitroActive, active: active && ui !== 'paused' });
  if (g) gearLabel = p.speed < -0.5 ? 'R' : Math.abs(p.speed) < 0.5 ? 'N' : String(g);
  grade.uniforms.uTime.value = elapsed % 100;
  if (ui === 'menu') grade.uniforms.uSpeed.value = 0;
  composer.render(dt);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- test / automation hooks
let testAutopilot = false;
window.__game = {
  get ui() { return ui; },
  getState() {
    const p = race.player;
    return {
      ui, mode: race.mode, raceState: race.state, time: race.time, countdown: race.countdown, laps: race.laps, difficulty: race.difficulty,
      camera: CAMERAS[camMode], muted: audio.muted, quality: settings.quality, autoLevel, fps, frames, touch: isTouch,
      position: race.positionOf(p),
      player: { x: p.x, z: p.z, heading: p.heading, speed: p.speed, kmh: Math.abs(p.speed) * 3.6, lap: p.lapCounter + 1,
        lapCounter: p.lapCounter, nitro: p.nitro, nitroActive: p.nitroActive, drift: p.drift, offroad: p.offroad, lat: p.lat,
        lapTimes: [...p.lapTimes], finished: p.finished, finishTime: p.finishTime, color: p.color, wrongWay: p.wrongWay },
      cars: race.cars.map((c) => ({ name: c.name, x: c.x, z: c.z, speed: c.speed, lap: c.lapCounter + 1, finished: c.finished, lat: c.lat })),
      render: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
    };
  },
  /** Run the simulation synchronously (no rendering). */
  simulate(seconds, { autopilot = true, input = null } = {}) {
    const steps = Math.round(seconds / FIXED_DT);
    const inp = input || { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
    for (let i = 0; i < steps; i++) {
      race.step(FIXED_DT, inp, autopilot || race.player.finished);
      handleEvents(race.drainEvents());
    }
    return this.getState();
  },
  setAutopilot(v) { testAutopilot = !!v; },
  teleport(lateral, speed = 0, reverse = false) {
    const p = race.player;
    const pt = race.track;
    p.x = pt.px[p.idx] + pt.sx[p.idx] * lateral; p.z = pt.pz[p.idx] + pt.sz[p.idx] * lateral;
    p.heading = Math.atan2(pt.tx[p.idx], pt.tz[p.idx]) + (reverse ? Math.PI : 0);
    p.vx = Math.sin(p.heading) * speed; p.vz = Math.cos(p.heading) * speed;
  },
  /** Render one frame and sample a 9x9 grid of pixels from the WebGL canvas. */
  snapshotStats() {
    composer.render(0);
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(4);
    let sum = 0, n = 0;
    const colors = new Set();
    for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) {
      gl.readPixels(Math.floor(w * i / 10), Math.floor(h * j / 10), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      sum += px[0] + px[1] + px[2]; n++;
      colors.add(((px[0] >> 4) << 8) | ((px[1] >> 4) << 4) | (px[2] >> 4));
    }
    return { avg: sum / (n * 3), distinct: colors.size, w, h };
  },
};

// ---------------------------------------------------------------- boot
applyQuality();
syncMenu();
// wait for the photo textures + HDR sky before showing the game
world.onProgress((f) => { const b = $('load-bar'); if (b) b.style.width = Math.round(f * 100) + '%'; });
await world.ready;
// compile every shader up front (incl. nitro flames, hidden until used) so the
// first nitro / first smoke never causes a hitch mid-race
for (const v of carViews) for (const f of v.flames) f.visible = true;
renderer.compile(scene, camera);
for (const v of carViews) for (const f of v.flames) f.visible = false;
$('loading').classList.add('hidden');
show('menu', true);
document.body.dataset.ready = '1';
requestAnimationFrame((t) => { last = t; frame(t); });
