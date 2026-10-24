import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', testMatch: '**/*.spec.ts',
  fullyParallel: false, workers: 1, retries: 0, timeout: 30000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'work/playwright-report' }], ['json', { outputFile: 'work/playwright-results.json' }]],
  outputDir: 'work/playwright-artifacts',
  use: {
    baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  webServer: { command: 'npx tsx tests/e2e/server.ts', url: 'http://127.0.0.1:4173/api/health', reuseExistingServer: false, timeout: 30000 },
});
