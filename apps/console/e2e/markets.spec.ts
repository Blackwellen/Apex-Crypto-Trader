import { expect, test } from '@playwright/test';
import { createWorkspaceIfNeeded, login } from './helpers';
import { seedReferenceData, sweep, USDC } from './markets-helpers';

test.beforeAll(() => seedReferenceData());
const mine = (page: import('@playwright/test').Page) => page.locator(`a[href$="${USDC}"]`);
const myRow = (page: import('@playwright/test').Page) => page.getByRole('row').filter({ has: mine(page) });

test('markets: honest no-feed state, search by symbol/chain/contract/pair, tabs, watchlist + saved views persist across reload', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await login(page); await createWorkspaceIfNeeded(page); await page.goto('/markets');
  await expect(page.getByTestId('no-feed')).toContainText('No market data feed connected');
  await expect(page.getByTestId('no-feed')).toContainText('Coinbase');
  const search = page.getByLabel(/Search symbol, chain, contract/);
  await search.fill('usdc'); await expect(mine(page)).toBeVisible(); await expect(page.getByRole('link', { name: 'BTC' })).toHaveCount(0);
  await search.fill('ETH/USDC'); await expect(page.locator('a[href$="/native"]').first()).toBeVisible();
  await search.fill('0xa0b86991'); await expect(mine(page)).toBeVisible();
  await search.fill('solana'); await expect(page.getByText('No tokens match these filters')).toBeVisible();
  await search.fill('');
  await page.getByRole('tab', { name: 'CEX' }).click(); await expect(page.getByRole('link', { name: 'BTC' })).toBeVisible(); await expect(mine(page)).toHaveCount(0);
  await page.getByRole('tab', { name: 'All assets' }).click();

  // watchlist persists
  await myRow(page).getByRole('button', { name: 'Add USDC to watchlist' }).click();
  await expect(myRow(page).getByRole('button', { name: 'Remove USDC from watchlist' })).toBeVisible();
  await page.reload(); await page.getByRole('tab', { name: 'Watchlist' }).click();
  await expect(mine(page)).toBeVisible(); await expect(page.getByRole('link', { name: 'BTC' })).toHaveCount(0);

  // saved view persists server-side
  await page.getByRole('tab', { name: 'All assets' }).click(); await search.fill('usd');
  const name = `view-${Date.now()}`;
  await page.getByRole('button', { name: 'Save current filters' }).click(); await page.getByLabel('View name').fill(name); await page.getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await page.getByLabel('Saved views', { exact: true }).selectOption({ label: name }); await expect(search).toHaveValue('usd');
  await page.getByRole('button', { name: `Delete saved view ${name}` }).click(); await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);

  // cards mode + add by identity
  await page.getByRole('button', { name: 'Cards' }).click(); await expect(page.getByText('Price: no feed connected').first()).toBeVisible();
  await sweep(page, 'markets');
  expect(errors).toEqual([]);
});

test('token page: canonical identity, security gate shows WHY rejected, vendor score additive, planner math, no fake quotes', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page); await createWorkspaceIfNeeded(page);
  await page.goto(`/markets/${encodeURIComponent('eip155:1')}/${encodeURIComponent(USDC)}`);
  await expect(page.getByRole('heading', { name: 'USDC' })).toBeVisible();
  await expect(page.getByTestId('contract')).toHaveText(USDC);
  await expect(page.getByText('In canonical asset registry')).toBeVisible();
  await expect(page.getByText('No data connected for pools, order books, holders or transactions')).toBeVisible();

  await page.getByLabel('Token age (hours)').fill('2');
  await page.getByLabel('Representative SELL simulation succeeded').selectOption('no');
  await page.getByLabel('Blacklist / sell restriction function').selectOption('yes');
  await page.getByLabel('Vendor name (optional)').fill('goplus'); await page.getByLabel('Vendor risk score 0-100').fill('1');
  await page.getByRole('button', { name: 'Run security gate' }).click();
  const res = page.getByTestId('gate-result');
  await expect(res).toContainText('Stage 1 REJECTED'); await expect(res).toContainText('HONEYPOT_SELL_FAILS'); await expect(res).toContainText('BLACKLIST'); await expect(res).toContainText('UNKNOWN_CRITICAL_FIELD');
  await expect(res).toContainText('does NOT override native checks'); await expect(res).toContainText('Not admitted');
  await expect(page.getByText('Gate REJECTED this token')).toBeVisible();

  // planner: 1000 USDC, 30+50 bps per side, zero move -> hand-computed costs
  await page.getByLabel('Hypothesised gross move (bps)').fill('0');
  const p = page.getByTestId('planner-result');
  await expect(p).toContainText('Break-even gross move'); await expect(p).toContainText('-15.936 USDC');   // hand-computed: 1000 -> 992 after 80 bps entry; exit costs 80 bps of 992 -> 984.064
  await sweep(page, 'markets-asset');
});

test('token page: unknown identity is a 404 state, not a fabricated token', async ({ page }) => {
  await login(page); await createWorkspaceIfNeeded(page);
  await page.goto(`/markets/${encodeURIComponent('eip155:1')}/0xdeadbeef`);
  await expect(page.getByText('Could not load this data')).toBeVisible();
});
