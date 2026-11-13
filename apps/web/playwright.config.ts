import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.e2e.spec.ts',
  timeout: 180000,
  expect: { timeout: 20000 },
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:5175',
    viewport: { width: 390, height: 844 },
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] },
    trace: 'retain-on-failure',
  },
  webServer: { command: 'pnpm dev --host 127.0.0.1 --port 5175', url: 'http://127.0.0.1:5175', reuseExistingServer: true },
});
