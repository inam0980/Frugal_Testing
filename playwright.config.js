const { defineConfig } = require('@playwright/test');

/**
 * Section A suite configuration.
 *
 * Run headed for the walkthrough recording (the canvas state drift and the
 * chained interaction are the whole point, and they are worth seeing):
 *   HEADED=1 npx playwright test
 */
const HEADED = process.env.HEADED === '1';

module.exports = defineConfig({
  timeout: 180_000,
  expect: { timeout: 15_000 },

  // The canvas suite measures a 30-100ms interaction window against vsync.
  // Parallel workers would contend for the same CPU and smear that measurement,
  // so the suite runs serially and deliberately.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'artifacts/results.json' }],
  ],

  use: {
    headless: !HEADED,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    video: HEADED ? 'off' : 'retain-on-failure',
    actionTimeout: 15_000,
  },

  projects: [
    {
      name: 'q1-canvas-race',
      testDir: './q1-canvas-race',
    },
    {
      name: 'q2-replay-hmac',
      testDir: './q2-replay-hmac',
      use: { baseURL: 'http://127.0.0.1:4500' },
    },
    {
      name: 'q3-shadow-dom',
      testDir: './q3-shadow-dom',
    },
  ],

  webServer: [
    {
      command: 'node q1-canvas-race/testbed/server.js',
      url: 'http://127.0.0.1:4400/healthz',
      reuseExistingServer: true,
      stdout: 'pipe',
      timeout: 30_000,
    },
    {
      command: 'node q2-replay-hmac/server/mock-gateway.js',
      url: 'http://127.0.0.1:4500/healthz',
      reuseExistingServer: true,
      stdout: 'pipe',
      timeout: 30_000,
    },
  ],
});
