// Canvas-drawn speedometer and minimap.
const hex = (c) => '#' + c.toString(16).padStart(6, '0');

export class Speedometer {
  constructor(canvas) {
    this.c = canvas; this.g = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.size = 210;
    canvas.width = canvas.height = this.size * dpr;
    this.g.scale(dpr, dpr);
  }
  draw(kmh, nitro, nitroActive, gear) {
    const g = this.g, S = this.size, cx = S / 2, cy = S / 2, r = S * 0.42;
    g.clearRect(0, 0, S, S);
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, max = 320;
    // backdrop
    g.beginPath(); g.arc(cx, cy, r + 14, 0, Math.PI * 2);
    g.fillStyle = 'rgba(10,62,72,0.7)'; g.fill();
    // track
    g.lineCap = 'round';
    g.lineWidth = 10; g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
    // value arc
    const frac = Math.min(1, kmh / max);
    const grad = g.createLinearGradient(0, S, S, 0);
    grad.addColorStop(0, '#1ff6c0'); grad.addColorStop(0.6, '#03ba80'); grad.addColorStop(1, '#057bfb');
    g.strokeStyle = grad; g.shadowColor = '#03ba80'; g.shadowBlur = 10;
    g.beginPath(); g.arc(cx, cy, r, a0, a0 + (a1 - a0) * frac); g.stroke();
    g.shadowBlur = 0;
    // ticks
    g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = '600 10px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let v = 0; v <= max; v += 20) {
      const a = a0 + (a1 - a0) * (v / max);
      const major = v % 40 === 0;
      const r1 = r - 12, r2 = r - (major ? 22 : 17);
      g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = major ? 2 : 1;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
      if (major && v > 0 && v < max) g.fillText(String(v), cx + Math.cos(a) * (r - 33), cy + Math.sin(a) * (r - 33));
    }
    // needle
    const an = a0 + (a1 - a0) * frac;
    g.strokeStyle = '#fff'; g.lineWidth = 3; g.shadowColor = '#fff'; g.shadowBlur = 8;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(an) * (r - 8), cy + Math.sin(an) * (r - 8)); g.stroke();
    g.shadowBlur = 0;
    g.beginPath(); g.arc(cx, cy, 6, 0, Math.PI * 2); g.fillStyle = '#03ba80'; g.fill();
    // digital readout
    g.fillStyle = '#fff'; g.font = 'italic 800 34px system-ui, sans-serif';
    g.fillText(String(Math.round(kmh)), cx, cy + 34);
    g.font = '600 10px system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.6)';
    g.fillText('KM/H', cx, cy + 56);
    g.font = '800 16px system-ui, sans-serif'; g.fillStyle = '#1ff6c0';
    g.fillText(gear, cx, cy - 26);
    // nitro bar
    const bw = 96, bx = cx - bw / 2, by = S - 22;
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(bx, by, bw, 7);
    g.fillStyle = nitroActive ? '#7fc4ff' : '#057bfb';
    g.shadowColor = '#057bfb'; g.shadowBlur = nitroActive ? 16 : 6;
    g.fillRect(bx, by, bw * nitro, 7);
    g.shadowBlur = 0;
    g.font = '700 9px system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText('NITRO', cx, by - 7);
  }
}

export class Minimap {
  constructor(canvas, track) {
    this.c = canvas; this.g = canvas.getContext('2d'); this.track = track;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.size = 170;
    canvas.width = canvas.height = this.size * dpr;
    this.g.scale(dpr, dpr);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < track.N; i++) {
      minX = Math.min(minX, track.px[i]); maxX = Math.max(maxX, track.px[i]);
      minZ = Math.min(minZ, track.pz[i]); maxZ = Math.max(maxZ, track.pz[i]);
    }
    const pad = 14;
    this.scale = (this.size - pad * 2) / Math.max(maxX - minX, maxZ - minZ);
    this.ox = pad + ((this.size - pad * 2) - (maxX - minX) * this.scale) / 2 - minX * this.scale;
    this.oz = pad + ((this.size - pad * 2) - (maxZ - minZ) * this.scale) / 2 - minZ * this.scale;
  }
  // world -> map (x mirrored so the map matches the driver's left/right)
  map(x, z) { return [this.size - (x * this.scale + this.ox), this.size - (z * this.scale + this.oz)]; }
  draw(cars) {
    const g = this.g, S = this.size, t = this.track;
    g.clearRect(0, 0, S, S);
    g.fillStyle = 'rgba(10,62,72,0.62)';
    g.beginPath(); g.roundRect(0, 0, S, S, 14); g.fill();
    g.beginPath();
    for (let i = 0; i <= t.N; i += 4) {
      const [x, y] = this.map(t.px[i % t.N], t.pz[i % t.N]);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath();
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(31,246,192,0.35)'; g.lineWidth = 9; g.stroke();
    g.strokeStyle = '#e9e4ff'; g.lineWidth = 3; g.stroke();
    const [sx, sy] = this.map(t.px[0], t.pz[0]);
    g.fillStyle = '#fff'; g.fillRect(sx - 6, sy - 1.5, 12, 3);
    for (const c of [...cars].reverse()) {
      const [x, y] = this.map(c.x, c.z);
      g.save(); g.translate(x, y); g.rotate(-c.heading);
      g.fillStyle = hex(c.color);
      g.shadowColor = hex(c.color); g.shadowBlur = c.isPlayer ? 12 : 6;
      const s = c.isPlayer ? 6 : 4.5;
      g.beginPath(); g.moveTo(0, -s * 1.3); g.lineTo(s, s); g.lineTo(-s, s); g.closePath(); g.fill();
      if (c.isPlayer) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
      g.restore();
    }
  }
}
