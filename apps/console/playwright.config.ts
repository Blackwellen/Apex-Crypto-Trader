import { defineConfig } from '@playwright/test';
// Uses the pre-installed Chromium (do not run `playwright install`). API + console must already be running (see docs/OPERATIONAL_RUNBOOK.md).
export default defineConfig({
  testDir: './e2e', timeout: 60_000, workers: 1, retries: 0, reporter: [['list']],
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] }, trace: 'off' },
});
