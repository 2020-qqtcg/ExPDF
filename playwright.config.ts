import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chromium',
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1512, height: 1100 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
