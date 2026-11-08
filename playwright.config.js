import { defineConfig } from '@playwright/test';

// WebGL runs on SwiftShader (software GPU) in headless CI containers.
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // software WebGL is CPU heavy; run serially for stable timings
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 960, height: 540 },
    launchOptions: { args: GL_ARGS },
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node server.js',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
