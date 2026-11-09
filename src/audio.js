// Game audio: sampled engine (two recorded loops crossfaded by RPM), music
// with a final-lap switch, synthesised tyre squeal / wind / impacts / beeps.
// Samples are CC0 from OpenGameArt (see assets/CREDITS.md).
const BASE = './assets/audio/';

export class AudioFX {
  constructor() { this.ctx = null; this.muted = false; this.musicOn = true; this.buffers = {}; this.currentMusic = null; }

  init() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master);
    this.music = ctx.createGain(); this.music.gain.value = this.musicOn ? 0.32 : 0; this.music.connect(this.master);

    // engine bus: shaped by a low-pass that opens with throttle (on/off load)
    this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 1800;
    this.engBus = ctx.createGain(); this.engBus.gain.value = 0;
    this.engFilter.connect(this.engBus).connect(this.sfx);

    // synthesised engine: used until the samples have loaded
    this.synthGain = ctx.createGain(); this.synthGain.gain.value = 0.5;
    this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'square';
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    this.osc1.connect(this.synthGain); this.osc2.connect(g2).connect(this.synthGain);
    this.synthGain.connect(this.engFilter);
    this.osc1.start(); this.osc2.start();

    // noise for tyre squeal, wind and impacts
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    // tyre squeal: two resonant bands, wobbled slightly so it isn't a flat hiss
    this.skidGain = ctx.createGain(); this.skidGain.gain.value = 0;
    const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true;
    for (const [f, q, gv] of [[1150, 14, 1], [2350, 10, 0.55]]) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const gg = ctx.createGain(); gg.gain.value = gv;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 7 + Math.random() * 3;
      const lfoAmt = ctx.createGain(); lfoAmt.gain.value = f * 0.04;
      lfo.connect(lfoAmt).connect(bp.frequency); lfo.start();
      n.connect(bp).connect(gg).connect(this.skidGain);
    }
    this.skidGain.connect(this.sfx);
    const w = ctx.createBufferSource(); w.buffer = buf; w.loop = true;
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type = 'lowpass'; this.windFilter.frequency.value = 500;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    w.connect(this.windFilter).connect(this.windGain).connect(this.sfx);
    n.start(); w.start();

    this.loadSamples();
  }

  async load(name) {
    if (this.buffers[name]) return this.buffers[name];
    const res = await fetch(BASE + name);
    if (!res.ok) throw new Error(`audio ${name}: ${res.status}`);
    const data = await res.arrayBuffer();
    const b = await new Promise((ok, bad) => this.ctx.decodeAudioData(data, ok, bad));
    this.buffers[name] = b;
    return b;
  }

  async loadSamples() {
    try {
      const [idle, high] = await Promise.all([this.load('engine_idle.wav'), this.load('engine_high.wav')]);
      const ctx = this.ctx;
      const mk = (b) => {
        const s = ctx.createBufferSource(); s.buffer = b; s.loop = true;
        const g = ctx.createGain(); g.gain.value = 0;
        s.connect(g).connect(this.engFilter); s.start();
        return { s, g };
      };
      this.idle = mk(idle);
      this.high = mk(high);
      this.synthGain.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
      this.samplesReady = true;
    } catch (e) {
      console.warn('Engine samples unavailable, using synthesised engine.', e);
    }
  }

  /** Play a music track ('menu' | 'race' | 'final'), crossfading from the current one. */
  async playMusic(which) {
    if (!this.ctx || this.musicWanted === which) return;
    this.musicWanted = which;
    const file = { menu: 'music_menu.mp3', race: 'music_race.mp3', final: 'music_final_lap.mp3' }[which];
    let buf;
    try { buf = await this.load(file); } catch (e) { console.warn('Music unavailable', e); return; }
    if (this.musicWanted !== which) return; // superseded while loading
    const ctx = this.ctx, t = ctx.currentTime;
    if (this.currentMusic) {
      const old = this.currentMusic;
      old.g.gain.setTargetAtTime(0, t, 0.35);
      old.s.stop(t + 2);
    }
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
    // skip the MP3 encoder padding so the loop point is (nearly) seamless
    s.loopStart = 0.05; s.loopEnd = Math.max(0.1, buf.duration - 0.05);
    const g = ctx.createGain(); g.gain.value = 0;
    s.connect(g).connect(this.music);
    s.start(t, 0.05);
    g.gain.setTargetAtTime(1, t, 0.4);
    this.currentMusic = { s, g, which };
  }

  /** Lower the music (pause / results) without stopping it. */
  duckMusic(on) {
    if (!this.ctx) return;
    this.music.gain.setTargetAtTime(this.musicOn ? (on ? 0.1 : 0.32) : 0, this.ctx.currentTime, 0.25);
  }

  setMusicOn(on) {
    this.musicOn = on;
    if (this.ctx) this.music.gain.setTargetAtTime(on ? 0.32 : 0, this.ctx.currentTime, 0.1);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  update({ speed, throttle, drift, nitro, active }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = Math.abs(speed);
    // 6-speed gearbox for RPM
    const gears = [0, 15, 28, 40, 51, 61, 999];
    let g = 1; while (v > gears[g] && g < 6) g++;
    const lo = gears[g - 1], hi = Math.min(gears[g], 75);
    const rpm = Math.min(1, 0.22 + 0.78 * Math.min(1, (v - lo) / (hi - lo)) + (throttle > 0 && v < 2 ? 0.25 : 0));
    // synth fallback pitch
    const f = 45 + rpm * 120 + g * 8;
    this.osc1.frequency.setTargetAtTime(f, t, 0.03);
    this.osc2.frequency.setTargetAtTime(f * 0.502, t, 0.03);
    if (this.samplesReady) {
      // idle recording dominates at low rpm, the racing loop takes over above ~40%
      const xf = Math.min(1, Math.max(0, (rpm - 0.3) / 0.35));
      this.idle.s.playbackRate.setTargetAtTime(0.8 + rpm * 1.1, t, 0.04);
      this.high.s.playbackRate.setTargetAtTime(0.62 + rpm * 0.95 + (nitro ? 0.08 : 0), t, 0.04);
      this.idle.g.gain.setTargetAtTime((1 - xf) * 1.6, t, 0.06);
      this.high.g.gain.setTargetAtTime(xf * (0.55 + throttle * 0.45), t, 0.06);
    }
    this.engFilter.frequency.setTargetAtTime(900 + throttle * 2600 + (nitro ? 1500 : 0), t, 0.05);
    this.engBus.gain.setTargetAtTime(active ? 0.55 + throttle * 0.35 : 0, t, 0.08);
    this.skidGain.gain.setTargetAtTime(active ? Math.min(0.32, Math.max(0, drift - 2.5) * 0.05) : 0, t, 0.05);
    this.windGain.gain.setTargetAtTime(active ? Math.min(0.22, v / 320) : 0, t, 0.1);
    return g;
  }

  beep(freq = 440, dur = 0.18, vol = 0.3) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.sfx); o.start(t); o.stop(t + dur + 0.02);
  }

  crash(strength = 10) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.9, strength / 25), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    s.connect(f).connect(g).connect(this.sfx); s.start(t, Math.random()); s.stop(t + 0.4);
    // metallic thump
    const o = this.ctx.createOscillator(), og = this.ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.25);
    og.gain.setValueAtTime(Math.min(0.6, strength / 30), t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(og).connect(this.sfx); o.start(t); o.stop(t + 0.32);
  }
}
