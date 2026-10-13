import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { createWorkspaceIfNeeded, login } from './helpers';
import { sweep } from './markets-helpers';

async function runWizard(page: import('@playwright/test').Page, label: string, bars = '400') {
  await page.getByRole('tab', { name: 'New backtest' }).click();
  await page.getByLabel('Run label (optional)').fill(label);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Window length (hourly bars)').fill(bars);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByLabel('Venue cost preset')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Bootstrap resamples (metric intervals)').fill('50');
  await page.getByLabel('Monte Carlo paths (with stress scenarios)').fill('50');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('This run will use seeded synthetic data')).toBeVisible();
  await page.getByRole('button', { name: 'Run backtest' }).click();
}

test('unauthenticated /research redirects to login', async ({ page }) => { await page.goto('/research'); await expect(page).toHaveURL(/\/login$/); });

test('research: wizard -> real researcher run -> results with provenance, uncertainty, statements -> reload persists -> history, compare, export -> axe/overflow x5', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await login(page); await createWorkspaceIfNeeded(page);
  await page.goto('/research');
  await expect(page.getByText('Researcher reachable')).toBeVisible();
  await expect(page.getByText(/seeded SYNTHETIC generator/).first()).toBeVisible();
  await expect(page.getByText('No backtests yet')).toBeVisible();

  await runWizard(page, 'e2e first');
  await page.waitForURL(/\/research\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  const url = page.url();
  await expect(page.getByRole('heading', { name: 'e2e first' })).toBeVisible();
  await expect(page.getByText(/DATA PROVENANCE: SYNTHETIC/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Survivorship bias' })).toContainText('delisted');
  await expect(page.getByRole('region', { name: 'No lookahead' })).toContainText('filled at open t+1');
  await expect(page.getByRole('heading', { name: 'Metrics with uncertainty' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /^\[-?[\d.]+, -?[\d.]+\]$|^\[.*\]$/ }).first()).toBeVisible();     // an interval, not just a point
  await expect(page.getByText('No equity series was returned')).toBeVisible();
  await expect(page.getByText('No out-of-sample evidence in this run')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Monte Carlo/ })).toBeVisible();

  // persisted: reload the page and the stored result is still there with provenance
  await page.reload();
  await expect(page.getByText(/DATA PROVENANCE: SYNTHETIC/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Metrics with uncertainty' })).toBeVisible();

  // export
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV' }).click()]);
  const csvText = fs.readFileSync((await csv.path())!, 'utf8'); expect(csvText).toContain('data_provenance'); expect(csvText).toContain('SYNTHETIC'); expect(csvText).toContain('Sharpe');
  const [json] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'JSON' }).click()]);
  const j = JSON.parse(fs.readFileSync((await json.path())!, 'utf8')); expect(j.data_provenance).toBe('SYNTHETIC'); expect(j.status).toBe('done');
  await sweep(page, 'research-results');

  // second run, then history + compare
  await page.goto('/research'); await runWizard(page, 'e2e second', '500');
  await page.waitForURL(/\/research\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  await page.goto('/research');
  await expect(page.getByRole('link', { name: 'e2e first' })).toBeVisible(); await expect(page.getByRole('link', { name: 'e2e second' })).toBeVisible();
  await page.getByLabel(/Select run e2e first/).check(); await page.getByLabel(/Select run e2e second/).check();
  await page.getByRole('tab', { name: 'Compare (2)' }).click();
  await expect(page.getByRole('heading', { name: 'Comparing 2 runs' })).toBeVisible();
  await expect(page.getByText('Sharpe').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Run history' }).click();
  await sweep(page, 'research-history');
  await page.getByRole('link', { name: 'e2e first' }).click(); await expect(page).toHaveURL(url);
  await page.goto('/research'); await page.getByRole('tab', { name: 'New backtest' }).click();
  await sweep(page, 'research-wizard');
  expect(errors).toEqual([]);
});

test('research: when the researcher is NOT REACHABLE the page says so and Run is disabled', async ({ page }) => {
  await login(page); await createWorkspaceIfNeeded(page);
  await page.route('**/api/proxy/v1/research/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reachable: false, origin: 'http://127.0.0.1:8100', checkedAt: new Date().toISOString(), error: 'researcher service is not reachable' }) }));
  await page.goto('/research');
  await expect(page.getByText('Researcher NOT REACHABLE')).toBeVisible();
  await page.getByRole('tab', { name: 'New backtest' }).click();
  await expect(page.getByRole('button', { name: 'Run backtest' })).toBeDisabled();
  await expect(page.getByText('Researcher NOT REACHABLE: Run is disabled.')).toBeVisible();
});

test('research: validation blocks bad allocation and the wizard disables controls the researcher does not support', async ({ page }) => {
  await login(page); await createWorkspaceIfNeeded(page); await page.goto('/research');
  await page.getByRole('tab', { name: 'New backtest' }).click();
  await page.getByLabel('risk_off allocation percent').fill('80');
  await expect(page.getByText(/Allocations add up to 130%/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await page.getByLabel('risk_off allocation percent').fill('0'); await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Window length (hourly bars)').fill('10'); await expect(page.getByText(/300 to 20000/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
});
