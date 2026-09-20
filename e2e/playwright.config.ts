import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // Models download on the first run and Whisper is not instant.
  timeout: 900_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', baseURL: 'http://localhost:5311' },
  webServer: {
    command: 'node serve.mjs',
    url: 'http://localhost:5311/page.html',
    reuseExistingServer: true,
    stdout: 'ignore',
  },
});
