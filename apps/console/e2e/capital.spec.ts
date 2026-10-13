import { expect, test, type Page } from '@playwright/test';
import { createWorkspaceIfNeeded, login } from './helpers';
import { EVM_A, SEED12, apiCmd, apiGet, evmAddr, psql, seedRegistry, sweep } from './capital-helpers';

test.beforeAll(() => seedRegistry());

const dlg = (page: Page, name: RegExp | string) => page.getByRole('dialog', { name });
async function newWorkspace(page: Page) { await login(page); await createWorkspaceIfNeeded(page); }

async function createPortfolio(page: Page, name: string) {
  await page.goto('/portfolios');
  await page.getByRole('button', { name: 'New portfolio' }).first().click();
  const d = dlg(page, 'New portfolio');
  await d.getByLabel('Portfolio name').fill(name);
  await d.getByRole('button', { name: 'Review' }).click();
  await d.getByRole('button', { name: 'Create portfolio' }).click();
  await expect(page.getByRole('link', { name })).toBeVisible();
}

async function createBucket(page: Page, name: string, opts: { segregation?: 'Physical' | 'Logical' | 'Protected'; slippage?: string } = {}) {
  await page.goto('/buckets');
  await page.getByRole('button', { name: 'New bucket' }).first().click();
  const d = dlg(page, 'New bucket');
  await d.getByLabel('Bucket name').fill(name);
  if (opts.segregation && opts.segregation !== 'Physical') await d.getByRole('radio', { name: opts.segregation }).check();
  await d.getByRole('button', { name: 'Next' }).click();
  if (opts.slippage) await d.getByLabel(/Max slippage/).fill(opts.slippage);
  await d.getByRole('button', { name: 'Next' }).click();      // wallets
  await d.getByRole('button', { name: 'Next' }).click();      // strategies & compounding
  await d.getByRole('button', { name: 'Next' }).click();      // review
  await d.getByRole('button', { name: 'Create bucket' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible({ timeout: 20_000 });
}

async function registerWallet(page: Page, nick: string, address: string, assignBucket?: string, shared = false) {
  await page.goto('/wallets');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  const d = dlg(page, 'Connect a wallet');
  await d.getByRole('radio', { name: /^EVM/ }).check(); await d.getByRole('button', { name: 'Next' }).click();
  await d.getByRole('radio', { name: /Public address, watch-only/ }).check(); await d.getByRole('button', { name: 'Next' }).click();
  await d.getByLabel('Wallet nickname').fill(nick); await d.getByLabel('Public address').fill(address); await d.getByRole('button', { name: 'Next' }).click();
  await d.getByLabel('Ethereum', { exact: false }).first().check();
  await d.getByLabel(/Anti-phishing check/).check(); await d.getByRole('button', { name: 'Next' }).click();
  if (assignBucket) {
    await d.getByRole('checkbox', { name: new RegExp(assignBucket) }).check();
    if (shared) { await d.getByLabel(/Share this wallet with other buckets/).check(); await d.getByLabel(/I understand this is logical separation only/).check(); }
  }
  await d.getByRole('button', { name: 'Next' }).click();
  await expect(d.getByText('On-chain balance verification not available until a certified read adapter is connected.')).toBeVisible();
  await d.getByRole('button', { name: 'Next' }).click();
  await d.getByRole('button', { name: 'Register wallet & write audit record' }).click();
  await expect(d.getByText('Wallet registered and audited')).toBeVisible({ timeout: 20_000 });
  await expect(d.getByText(/Audit record #\d+/)).toBeVisible();
  await d.getByRole('button', { name: 'Done' }).click();
}

const spendable = async (page: Page) => (await page.getByText('Spendable', { exact: true }).first().locator('xpath=following-sibling::div[1]').innerText()).trim();

test('flow: workspace -> portfolio -> bucket -> wallet wizard -> assign -> PAPER deposit -> allocate; balances survive reload; double submit does not double-fund', async ({ page }) => {
  test.setTimeout(240_000);
  await newWorkspace(page);
  await page.goto('/portfolios');
  await expect(page.getByText('No portfolios yet')).toBeVisible();

  // new-portfolio wizard: live is locked with real reasons
  await page.getByRole('button', { name: 'New portfolio' }).first().click();
  const pd = dlg(page, 'New portfolio');
  await expect(pd.getByRole('radio', { name: /Live/ })).toBeDisabled();
  await expect(pd.getByText('Why live is locked')).toBeVisible();
  await expect(pd.getByText(/owner has not opted in/)).toBeVisible();
  await pd.getByRole('button', { name: 'Cancel' }).click();

  await createPortfolio(page, 'Core');
  await page.reload(); await expect(page.getByRole('link', { name: 'Core' })).toBeVisible();

  await createBucket(page, 'Trading', { slippage: '50' });
  await expect(page.getByText('Physical segregation.')).toBeVisible();
  await expect(page.getByText('No wallet is assigned yet')).toBeVisible();
  const bucketUrl = page.url();

  const address = evmAddr();
  await registerWallet(page, 'Main wallet', address, 'Trading');
  await page.goto(bucketUrl);
  await page.getByRole('tab', { name: 'Wallets' }).click();
  await expect(page.getByRole('link', { name: 'Main wallet' })).toBeVisible();
  await expect(page.getByText('exclusive (physical)')).toBeVisible();

  // PAPER deposit
  await page.getByRole('button', { name: 'PAPER deposit' }).click();
  const fd = dlg(page, /PAPER deposit into a wallet/);
  await expect(fd.getByText('PAPER ledger funding').first()).toBeVisible();
  await fd.getByLabel('Wallet account (wallet · network)').selectOption({ label: 'Main wallet · Ethereum' });
  await fd.getByLabel('Asset').selectOption({ label: 'USDC · eip155:1' }).catch(async () => fd.getByLabel('Asset').selectOption({ index: 2 }));
  await fd.getByLabel(/^Amount/).fill('1000');
  await fd.getByRole('button', { name: 'Record PAPER deposit' }).click();
  await expect(page.getByText(/PAPER deposit of 1000 USDC recorded/)).toBeVisible();

  // allocate 600 -- and hammer the button to prove one click = one allocation
  await page.getByRole('button', { name: 'Allocate to bucket' }).click();
  const ad = dlg(page, /Allocate to Trading/);
  await ad.getByLabel('Wallet account (wallet · network)').selectOption({ label: 'Main wallet · Ethereum' });
  await ad.getByLabel('Asset').selectOption({ label: 'USDC · eip155:1' });
  await expect(ad.getByText(/Wallet pool available to allocate/)).toContainText('1,000');
  await ad.getByLabel(/^Amount/).fill('600');
  await ad.getByRole('button', { name: 'Allocate', exact: true }).dblclick();
  await expect(page.getByText(/Allocated 600 USDC to Trading/)).toBeVisible();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByText('USDC · paper ledger')).toBeVisible();
  await expect.poll(() => spendable(page)).toBe('600');

  // over-allocation is refused client-side (400 would exceed pool 400)
  await page.getByRole('button', { name: 'Allocate to bucket' }).click();
  const ad2 = dlg(page, /Allocate to Trading/);
  await ad2.getByLabel('Wallet account (wallet · network)').selectOption({ label: 'Main wallet · Ethereum' });
  await ad2.getByLabel('Asset').selectOption({ label: 'USDC · eip155:1' });
  await ad2.getByLabel(/^Amount/).fill('401');
  await expect(ad2.getByText(/Exceeds available/)).toBeVisible();
  await expect(ad2.getByRole('button', { name: 'Allocate', exact: true })).toBeDisabled();
  await ad2.getByLabel(/^Amount/).fill('100');
  await ad2.getByRole('button', { name: 'Allocate', exact: true }).click();
  await expect(page.getByText(/Allocated 100 USDC to Trading/)).toBeVisible();

  // persisted: reload and read back from the API as well as the UI
  await page.reload();
  await expect.poll(() => spendable(page)).toBe('700');
  const id = bucketUrl.split('/').pop()!;
  const api = await apiGet(page, `v1/buckets/${id}`);
  expect(api.balances.find((b: any) => b.state === 'available' && b.symbol === 'USDC').amount).toBe('700000000');
  // audit tab carries the wallet assignment and policy change
  await page.getByRole('tab', { name: 'Audit' }).click();
  await expect(page.getByRole('cell', { name: 'bucket.policy' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'wallet.assign' })).toBeVisible();
  // wallets page shows the wallet with ledger balance, detail shows per-chain balances and activity
  await page.goto('/wallets');
  await expect(page.getByRole('heading', { name: 'Main wallet' })).toBeVisible();
  await page.getByRole('link', { name: 'Main wallet' }).click();
  await expect(page.getByText(address.toLowerCase()).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Ethereum/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByRole('cell', { name: 'allocate' }).first()).toBeVisible();
});
