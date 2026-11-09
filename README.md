# Neon Velocity

A realistic-looking 3D racing game that runs in the browser, built with
[Three.js](https://threejs.org). Race three AI rivals around a daytime
circuit lit by a real HDR sky, or set a time in solo Time Trial.

![Race view](docs/race.png)

## Play

```bash
npm install      # only needed for the tests; the game itself has no build step
npm start        # serves the game on http://localhost:4173
```

Any static file server works too (the game is plain ES modules; Three.js is
vendored in `vendor/three`, so nothing is fetched from a CDN).

### Controls

| Action | Keyboard | Gamepad | Touch |
| --- | --- | --- | --- |
| Accelerate | `W` / `↑` | RT | ▲ |
| Brake / reverse | `S` / `↓` | LT | ▼ |
| Steer | `A` `D` / `←` `→` | Left stick | ◀ ▶ |
| Handbrake drift | `Space` | B | DRIFT |
| Nitro | `Shift` / `N` | A | ⚡ |
| Camera (chase / far / hood) | `C` | | |
| Reset car to track | `R` | | |
| Pause | `P` / `Esc` | | II |
| Mute | `M` | | |

## Features

- **Look:** real HDR sky (Poly Haven) for the backdrop, lighting and
  reflections; photo textures for the track asphalt, grass, concrete walls
  and gravel traps; fir forests built from photo branch cards; catch
  fences, ad boards, a grandstand and rolling hills. ACES tone mapping,
  soft shadows, MSAA, subtle bloom and speed blur.
- **Driving:** a single-track ("bicycle") vehicle model with non-linear
  tyres, friction circle, load transfer, downforce, AWD with a rear bias,
  ABS-limited rear brakes, traction control and a light stability assist.
  0-100 km/h in 2.3 s, 100-0 km/h braking in 32 m, about 255 km/h top speed.
  Handbrake drifts fill the nitro tank.
- **AI:** three rivals follow a racing line, plan their braking from a
  grip-limited speed plan, overtake, use nitro, and recover from spins.
- **Sound:** recorded engine loops crossfaded by RPM through six gears;
  racing music that switches to a faster version on the final lap; menu
  music; synthesised tyre squeal, wind and impacts.
- **Modes and settings:** Grand Prix or Time Trial; 1, 3 or 5 laps; Easy,
  Normal or Hard AI; six paint colours; High quality or Performance
  graphics, plus automatic quality scaling on slower devices.
- **HUD:** live positions with gaps, lap timers, speedometer with gear and
  nitro, minimap, start lights, countdown, wrong-way warning, results.
- **Mobile:** touch controls sized to the screen, checked on five phone
  sizes for overlaps.

All third-party assets are CC0; see [assets/CREDITS.md](assets/CREDITS.md).
The game downloads about 6 MB before the menu appears; music (about 5 MB)
streams in afterwards.

## Tests

The end-to-end suite drives the real game in Chromium with Playwright. WebGL
runs on SwiftShader, a software renderer, so the tests also pass on machines
with no GPU.

```bash
npm install
npx playwright install chromium   # skip if Chromium is already installed
npm test
```

What the tests cover:

| Area | What is checked |
| --- | --- |
| Boot and rendering | No console errors; the WebGL output is a lit, varied scene (pixel sampling), not a blank screen |
| Menu | Paint, mode, difficulty and laps buttons respond, and the choices survive a page reload |
| Driving | The real-time countdown, then keyboard throttle, steering and braking |
| Pause | Pausing freezes the race clock; Resume continues it; Restart begins a new countdown |
| Hotkeys | Camera cycling, mute, and resetting the car to the track |
| Physics | Barriers keep the car on the track; nitro gives a measurable speed boost |
| Sound | Engine recordings load; music switches menu -> race -> final lap; music toggle |
| Phone layout | No control or HUD element overlaps another on five phone sizes |
| AI | All rivals drive inside the track at racing speed, and the live leaderboard updates |
| Warnings | Driving the wrong way shows a warning |
| Full race | A complete race ends on the results screen, best times are saved, and Race Again works |
| Time Trial | A solo lap ends on a TIME TRIAL result |
| Mobile | Touch buttons work on a Pixel 7 viewport, with no horizontal scrolling |

For tests and automation, the page exposes `window.__game`
(`getState()`, `simulate(seconds, opts)`, `teleport()`, `snapshotStats()`).
`simulate()` runs the same fixed-step (120 Hz) simulation the game loop uses,
without rendering, so a full race can be checked in seconds.

## Project layout

```
index.html          UI shell, styles, import map
server.js           zero-dependency static server (npm start)
src/main.js         renderer, post-processing, input, UI, game loop, test hooks
src/race.js         race manager: grid, countdown, laps, standings, results
src/physics.js      car physics, AI driver, car-to-car collisions
src/track.js        circuit spline, sampling, nearest-point queries
src/world.js        HDR sky, lighting, road, curbs, barriers, scenery
src/textures.js     procedural noise helpers
src/post.js         final lens/grade pass
assets/             CC0 images, HDR sky and audio (see CREDITS.md)
src/carModel.js     procedural car mesh
src/effects.js      particle system and skid marks
src/audio.js        engine samples, music, synthesised effects
src/hud.js          speedometer and minimap
tests/game.spec.js  Playwright end-to-end tests
vendor/three/       Three.js r170 (MIT) and the post-processing add-ons it needs
```
