// Fully synthesised audio (no asset files): engine, tyre screech, impacts, beeps.
export class AudioFX {
  constructor() { this.ctx = null; this.muted = false; }

  init() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.5;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // engine: two detuned oscillators through a lowpass
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 900;
    this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'square';
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    this.osc1.connect(this.engFilter); this.osc2.connect(g2).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.master);
    this.osc1.start(); this.osc2.start();

    // noise for screech / wind / impacts
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true;
    this.skidFilter = ctx.createBiquadFilter(); this.skidFilter.type = 'bandpass'; this.skidFilter.frequency.value = 1800; this.skidFilter.Q.value = 6;
    this.skidGain = ctx.createGain(); this.skidGain.gain.value = 0;
    n.connect(this.skidFilter).connect(this.skidGain).connect(this.master);
    const w = ctx.createBufferSource(); w.buffer = buf; w.loop = true;
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type = 'lowpass'; this.windFilter.frequency.value = 500;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    w.connect(this.windFilter).connect(this.windGain).connect(this.master);
    n.start(); w.start();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.05);
  }

  update({ speed, throttle, drift, nitro, active }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = Math.abs(speed);
    // fake 6-speed gearbox for RPM
    const gears = [0, 14, 26, 38, 50, 61, 999];
    let g = 1; while (v > gears[g] && g < 6) g++;
    const lo = gears[g - 1], hi = Math.min(gears[g], 75);
    const rpm = 0.25 + 0.75 * Math.min(1, (v - lo) / (hi - lo));
    const f = 45 + rpm * 120 + g * 8;
    this.osc1.frequency.setTargetAtTime(f, t, 0.03);
    this.osc2.frequency.setTargetAtTime(f * 0.502, t, 0.03);
    this.engFilter.frequency.setTargetAtTime(500 + throttle * 1600 + (nitro ? 1200 : 0), t, 0.05);
    this.engGain.gain.setTargetAtTime(active ? 0.1 + throttle * 0.12 : 0, t, 0.08);
    this.skidGain.gain.setTargetAtTime(active ? Math.min(0.28, Math.max(0, drift - 3) * 0.035) : 0, t, 0.05);
    this.windGain.gain.setTargetAtTime(active ? Math.min(0.25, v / 300) : 0, t, 0.1);
    return g;
  }

  beep(freq = 440, dur = 0.18, vol = 0.3) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }

  crash(strength = 10) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.9, strength / 25), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    s.connect(f).connect(g).connect(this.master); s.start(t, Math.random()); s.stop(t + 0.4);
  }
}
