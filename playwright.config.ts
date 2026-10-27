import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for the admin SPA. NOT part of `npm test` (vitest) — run
 * `npm run test:e2e`, which builds, starts examples/express/server.js on a free
 * port and passes it here as E2E_BASE_URL.
 *
 * One worker, serial: the example server is a single in-memory database shared
 * by every test, and the first test needs it empty.
 */
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // Repo-relative and gitignored, so CI can upload traces on failure.
  // (Not under test/: scripts/check-tracked.mjs fails on untracked files there.)
  outputDir: 'playwright-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000/admin/links/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
