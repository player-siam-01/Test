// End-to-end tests for Neon Velocity. They drive the real game in Chromium
// (WebGL via SwiftShader): menus, keyboard/touch input, physics, AI, laps,
// pause, results, persistence and rendering output.
import { test, expect, devices } from '@playwright/test';

const WALL_LIMIT = 14 - 1.1; // WALL_DIST - car half width (see src/physics.js)

/** Fail any test that logs a page error or console error. */
function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return errors;
}

async function boot(page, query = '?quality=low') {
  await page.goto('/' + query);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 60_000 });
  await expect(page.locator('#menu')).toBeVisible();
}

const state = (page) => page.evaluate(() => window.__game.getState());
const simulate = (page, seconds, opts = {}) =>
  page.evaluate(([s, o]) => window.__game.simulate(s, o), [seconds, opts]);

async function startAndWaitForGreen(page) {
  await page.click('#start-btn');
  await expect(page.locator('#hud')).toBeVisible();
  // skip the 3 s countdown deterministically
  const s = await simulate(page, 3.1, { autopilot: false });
  expect(s.raceState).toBe('racing');
}

let errors;
test.beforeEach(async ({ page }) => { errors = trackErrors(page); });
test.afterEach(async () => { expect(errors, errors.join('\n')).toEqual([]); });

test('boots, renders a lit 3D scene and shows the main menu', async ({ page }) => {
  await boot(page, '?quality=high');
  await expect(page).toHaveTitle('Neon Velocity');
  await expect(page.locator('.title').first()).toContainText('NEON');
  await expect(page.locator('#loading')).toBeHidden();

  const pix = await page.evaluate(() => window.__game.snapshotStats());
  expect(pix.w).toBeGreaterThan(0);
  expect(pix.avg).toBeGreaterThan(12);       // not a black screen
  expect(pix.distinct).toBeGreaterThan(12);  // real scene, not a flat clear colour

  const s = await state(page);
  expect(s.ui).toBe('menu');
  expect(s.cars).toHaveLength(4);
  expect(s.frames).toBeGreaterThan(1);       // render loop is running
});

test('menu options are interactive and persist across reloads', async ({ page }) => {
  await boot(page);
  const yellow = page.locator('.swatch[data-v="16765471"]'); // 0xffd21f
  await yellow.click();
  await expect(yellow).toHaveAttribute('aria-pressed', 'true');
  expect((await state(page)).player.color).toBe(0xffd21f);

  await page.click('#difficulty button[data-v="hard"]');
  await page.click('#laps button[data-v="5"]');
  await expect(page.locator('#difficulty button[data-v="hard"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#laps button[data-v="5"]')).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
  await expect(page.locator('.swatch[data-v="16765471"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#difficulty button[data-v="hard"]')).toHaveAttribute('aria-pressed', 'true');

  await page.click('#start-btn');
  const s = await state(page);
  expect(s.laps).toBe(5);
  expect(s.difficulty).toBe('hard');
  await expect(page.locator('#hud-lap')).toHaveText('LAP 1/5');
});

test('countdown runs in real time, then keyboard controls drive the car', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#hud')).toBeVisible();
  await expect(page.locator('#countdown')).toHaveText(/^[123]$/);
  expect((await state(page)).raceState).toBe('countdown');
  await expect.poll(async () => (await state(page)).raceState, { timeout: 30_000 }).toBe('racing');

  const s0 = await state(page);
  await page.keyboard.down('ArrowUp');
  await expect.poll(async () => (await state(page)).player.speed, { timeout: 20_000 }).toBeGreaterThan(8);
  await expect.poll(async () => {
    const p = (await state(page)).player;
    return Math.hypot(p.x - s0.player.x, p.z - s0.player.z);
  }, { timeout: 20_000 }).toBeGreaterThan(2);
  const s1 = await state(page);
  await expect(page.locator('#speedo')).toBeVisible();

  // steering left turns the car (heading increases)
  const h0 = s1.player.heading;
  await page.keyboard.down('ArrowLeft');
  await expect.poll(async () => (await state(page)).player.heading - h0, { timeout: 20_000 }).toBeGreaterThan(0.05);
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.up('ArrowUp');

  // braking slows the car down
  const v = (await state(page)).player.speed;
  await page.keyboard.down('ArrowDown');
  await expect.poll(async () => (await state(page)).player.speed, { timeout: 20_000 }).toBeLessThan(v - 3);
  await page.keyboard.up('ArrowDown');
});

test('pause freezes the race clock and resume continues it', async ({ page }) => {
  await boot(page);
  await startAndWaitForGreen(page);
  await expect.poll(async () => (await state(page)).time, { timeout: 20_000 }).toBeGreaterThan(0.2);

  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeVisible();
  const t1 = (await state(page)).time;
  expect((await state(page)).ui).toBe('paused');
  await page.waitForTimeout(1200);
  expect((await state(page)).time).toBe(t1);

  await page.click('#resume-btn');
  await expect(page.locator('#pause')).toBeHidden();
  await expect.poll(async () => (await state(page)).time, { timeout: 20_000 }).toBeGreaterThan(t1 + 0.2);

  // the on-screen pause button works too, and Restart begins a fresh countdown
  await page.click('#pause-btn');
  await expect(page.locator('#pause')).toBeVisible();
  await page.click('#restart-btn');
  await expect(page.locator('#pause')).toBeHidden();
  expect((await state(page)).raceState).toBe('countdown');
});

test('hotkeys: camera cycle, mute toggle and car reset', async ({ page }) => {
  await boot(page);
  await startAndWaitForGreen(page);
  expect((await state(page)).camera).toBe('chase');
  await page.keyboard.press('c');
  expect((await state(page)).camera).toBe('far');
  await page.keyboard.press('c');
  expect((await state(page)).camera).toBe('hood');
  await page.keyboard.press('c');
  expect((await state(page)).camera).toBe('chase');

  const muted = (await state(page)).muted;
  await page.keyboard.press('m');
  expect((await state(page)).muted).toBe(!muted);

  await page.evaluate(() => window.__game.teleport(11));
  expect(Math.abs((await simulate(page, 0.05, { autopilot: false })).player.lat)).toBeGreaterThan(9);
  await page.keyboard.press('r');
  const s = await simulate(page, 0.05, { autopilot: false });
  expect(Math.abs(s.player.lat)).toBeLessThan(1);
  expect(Math.abs(s.player.speed)).toBeLessThan(1);
});

test('barriers contain the car and slow it on impact', async ({ page }) => {
  await boot(page);
  await page.click('#mode button[data-v="trial"]');
  await startAndWaitForGreen(page);
  expect((await state(page)).cars).toHaveLength(1);
  // floor it while steering hard right into the barrier, sampling every step
  const res = await page.evaluate((lim) => {
    let maxLat = 0, hits = 0;
    for (let i = 0; i < 400; i++) {
      const s = window.__game.simulate(1 / 60, { autopilot: false, input: { throttle: 1, brake: 0, steer: 1, handbrake: false, nitro: false } });
      maxLat = Math.max(maxLat, Math.abs(s.player.lat));
      if (Math.abs(s.player.lat) > lim - 0.3) hits++;
    }
    return { maxLat, hits };
  }, WALL_LIMIT);
  expect(res.hits).toBeGreaterThan(0);            // we did reach the wall
  expect(res.maxLat).toBeLessThanOrEqual(WALL_LIMIT + 0.05); // and never went through it
});

test('time trial: solo lap shows a TIME TRIAL result', async ({ page }) => {
  await boot(page);
  await page.click('#mode button[data-v="trial"]');
  await page.click('#laps button[data-v="1"]');
  await startAndWaitForGreen(page);
  const s = await simulate(page, 40, { autopilot: true });
  expect(s.mode).toBe('trial');
  expect(s.player.finished).toBe(true);
  await expect(page.locator('#results')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#res-title')).toHaveText('TIME TRIAL');
  await expect(page.locator('#res-body tr')).toHaveCount(1);
});

test('nitro gives a measurable speed boost and drains the tank', async ({ page }) => {
  await boot(page);
  await page.click('#mode button[data-v="trial"]'); // solo, so no rivals get in the way
  const run = async (nitro) => {
    await page.evaluate(() => document.getElementById('start-btn').click());
    await simulate(page, 3.1, { autopilot: false });
    await page.evaluate(() => window.__game.teleport(0)); // centre of the straight, aligned with it
    // 2.5 s keeps both runs on the asphalt of the start straight
    return simulate(page, 2.5, { autopilot: false, input: { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro } });
  };
  const plain = await run(false);
  await page.evaluate(() => document.getElementById('quit-btn').click());
  const boosted = await run(true);
  expect(boosted.player.speed).toBeGreaterThan(plain.player.speed + 3);
  expect(boosted.player.nitro).toBeLessThan(plain.player.nitro);
});

test('AI rivals race and the leaderboard updates', async ({ page }) => {
  await boot(page);
  await startAndWaitForGreen(page);
  const s = await simulate(page, 12, { autopilot: true });
  for (const c of s.cars) {
    expect(c.speed).toBeGreaterThan(10);
    expect(Math.abs(c.lat)).toBeLessThan(WALL_LIMIT + 0.05);
  }
  await expect(page.locator('#hud-board li')).toHaveCount(4);
  await expect(page.locator('#hud-board li.me')).toContainText('YOU');
  await expect(page.locator('#hud-pos')).toHaveText(/^[1-4]\/4$/);
});

test('driving the wrong way shows a warning', async ({ page }) => {
  await boot(page);
  await startAndWaitForGreen(page);
  await simulate(page, 2, { autopilot: true });
  await page.evaluate(() => window.__game.teleport(0, 15, true));
  const s = await simulate(page, 0.3, { autopilot: false, input: { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false } });
  expect(s.player.wrongWay).toBe(true);
  await expect(page.locator('#banner')).toHaveText('WRONG WAY');
});

test('full race: finishing shows results, records best times, and can restart', async ({ page }) => {
  await boot(page);
  await page.click('#laps button[data-v="1"]');
  await startAndWaitForGreen(page);
  await expect(page.locator('#hud-lap')).toHaveText('LAP 1/1');

  const s = await simulate(page, 45, { autopilot: true });
  expect(s.player.finished).toBe(true);
  expect(s.player.lapTimes).toHaveLength(1);
  expect(s.player.finishTime).toBeGreaterThan(15);
  expect(s.player.finishTime).toBeLessThan(45);

  const results = page.locator('#results');
  await expect(results).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#res-title')).toHaveText(/VICTORY!|(2ND|3RD|4TH) PLACE/);
  await expect(page.locator('#res-body tr')).toHaveCount(4);
  await expect(page.locator('#res-body tr.me')).toContainText('YOU');
  await expect(page.locator('#res-sub')).toContainText('Best lap');

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('nv-best')));
  expect(stored.lap).toBeCloseTo(s.player.lapTimes[0], 3);
  expect(stored.race1).toBeCloseTo(s.player.finishTime, 3);

  await page.click('#menu-btn');
  await expect(page.locator('#menu')).toBeVisible();
  await expect(page.locator('#best-label')).toContainText('BEST LAP');

  await page.click('#start-btn');
  await expect(page.locator('#results')).toBeHidden();
  expect((await state(page)).raceState).toBe('countdown');
});

test('touch controls work on a phone-sized screen', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  const errs = trackErrors(page);
  await boot(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect((await state(page)).touch).toBe(true);

  await page.click('#start-btn');
  await expect(page.locator('#t-gas')).toBeVisible();
  await expect(page.locator('#t-left')).toBeVisible();
  await simulate(page, 3.1, { autopilot: false });

  await page.dispatchEvent('#t-gas', 'pointerdown', { pointerId: 1, isPrimary: true });
  await expect(page.locator('#t-gas')).toHaveClass(/on/);
  await expect.poll(async () => (await state(page)).player.speed, { timeout: 20_000 }).toBeGreaterThan(5);
  await page.dispatchEvent('#t-gas', 'pointerup', { pointerId: 1, isPrimary: true });
  await expect(page.locator('#t-gas')).not.toHaveClass(/on/);

  const h0 = (await state(page)).player.heading;
  await page.dispatchEvent('#t-right', 'pointerdown', { pointerId: 2 });
  await expect.poll(async () => (await state(page)).player.heading, { timeout: 20_000 }).toBeLessThan(h0 - 0.03);
  await page.dispatchEvent('#t-right', 'pointerup', { pointerId: 2 });
  expect(errs).toEqual([]);
  await ctx.close();
});
