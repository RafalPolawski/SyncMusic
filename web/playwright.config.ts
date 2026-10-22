import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 18080);

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'pl-PL',
    trace: 'retain-on-failure',
    launchOptions: {
      // Lets tests use a preinstalled Chromium (e.g. PW_CHROMIUM=/opt/pw-browsers/...).
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [{ name: 'android', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    env: { E2E_PORT: String(port) },
  },
});
