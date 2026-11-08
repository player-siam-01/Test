// Final "camera lens" pass: speed-driven radial blur, chromatic fringing at the
// edges, vignette, gentle contrast/saturation grade and fine film grain.
export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSpeed: { value: 0 },   // 0..1 (nitro pushes it higher)
    uTime: { value: 0 },
    uVignette: { value: 0.32 },
  },
  vertexShader: `varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uSpeed; uniform float uTime; uniform float uVignette;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 c = vec2(0.5, 0.52);
      vec2 d = vUv - c;
      float r = length(d);
      // radial motion blur, strongest at the screen edges, none in the centre
      float amt = uSpeed * smoothstep(0.12, 0.75, r) * 0.045;
      vec3 col = vec3(0.0);
      if (uSpeed < 0.02) {
        // cheap path when slow: single tap with a faint edge fringe
        float ca = 0.0016 * r * r * 4.0;
        col = vec3(texture2D(tDiffuse, vUv + d * ca).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - d * ca).b) * 8.0;
      } else
      for (int i = 0; i < 8; i++) {
        float t = float(i) / 7.0;
        vec2 uv = vUv - d * amt * t;
        // subtle chromatic split toward the edges
        float ca = 0.0016 * r * r * 4.0 + amt * 0.08;
        col.r += texture2D(tDiffuse, uv + d * ca).r;
        col.g += texture2D(tDiffuse, uv).g;
        col.b += texture2D(tDiffuse, uv - d * ca).b;
      }
      col /= 8.0;
      // grade: slight S-curve contrast and saturation lift
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, 1.12);
      col = col * col * (3.0 - 2.0 * col) * 0.35 + col * 0.65;
      // vignette
      float v = smoothstep(0.95, 0.25, r * (1.0 + uVignette));
      col *= mix(1.0 - uVignette, 1.0, v);
      // film grain
      col += (hash(vUv * 1000.0 + uTime) - 0.5) * 0.018;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};
