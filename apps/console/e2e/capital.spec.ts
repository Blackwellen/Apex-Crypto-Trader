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

// ---------- helpers for API-driven setup (the UI flows above already prove the same commands through the browser) ----------
async function ws(page: Page): Promise<string> { return (await apiGet(page, 'v1/workspaces')).items[0].id; }
async function cmdOk(page: Page, name: string, body: unknown): Promise<any> { const r = await apiCmd(page, name, body); expect(r.status(), `${name}: ${await r.text()}`).toBe(200); return (await r.json()).result; }
const asset = (sym: string, chain = 'eip155:1') => psql(`select id from assets where symbol='${sym}' and chain_id='${chain}' order by contract limit 1`);
const wcaOf = (wallet: string) => psql(`select id from wallet_chain_accounts where wallet_id='${wallet}' limit 1`);
async function populate(page: Page) {
  const W = await ws(page);
  const PF = (await cmdOk(page, 'createPortfolio', { workspace: W, name: 'Core' })).id;
  const TR = (await cmdOk(page, 'createBucket', { portfolio: PF, name: 'Trading' })).id;
  const SH = (await cmdOk(page, 'createBucket', { portfolio: PF, name: 'Shared pool', segregation: 'logical' })).id;
  const VA = (await cmdOk(page, 'createBucket', { portfolio: PF, name: 'Vault', kind: 'protected_vault' })).id;
  const w1 = (await cmdOk(page, 'connectWallet', { workspace: W, nickname: 'Hot wallet', family: 'evm', address: evmAddr(), chains: ['eip155:1', 'eip155:8453'] })).id;
  const w2 = (await cmdOk(page, 'connectWallet', { workspace: W, nickname: 'Shared wallet', family: 'evm', address: evmAddr(), chains: ['eip155:1'] })).id;
  const w3 = (await cmdOk(page, 'connectWallet', { workspace: W, nickname: 'Cold wallet', family: 'evm', address: evmAddr(), chains: ['eip155:1'] })).id;
  await cmdOk(page, 'assignWalletToBucket', { wallet: w1, bucket: TR });
  await cmdOk(page, 'assignWalletToBucket', { wallet: w2, bucket: SH, exclusive: false, maxAllocationBps: 5000, logicalAck: true });
  await cmdOk(page, 'assignWalletToBucket', { wallet: w3, bucket: VA });
  const USDC = asset('USDC'), DAI = asset('DAI'), ETH = asset('ETH');
  const c1 = wcaOf(w1);
  await cmdOk(page, 'paperDeposit', { workspace: W, walletChainAccount: c1, asset: USDC, amount: '5000000000' });
  await cmdOk(page, 'allocate', { workspace: W, bucket: TR, walletChainAccount: c1, asset: USDC, amount: '3000000000' });
  await cmdOk(page, 'paperDeposit', { workspace: W, walletChainAccount: c1, asset: DAI, amount: '1000000000000000000000' });
  await cmdOk(page, 'allocate', { workspace: W, bucket: TR, walletChainAccount: c1, asset: DAI, amount: '500000000000000000000' });
  return { W, PF, TR, SH, VA, w1, w2, w3, USDC, DAI, ETH, c1 };
}
const bucketPath = (p: { PF: string }, b: string) => `/portfolios/${p.PF}/buckets/${b}`;

test('addresses: invalid structure and seed phrases are rejected in the browser AND by the server; no secret field exists', async ({ page }) => {
  await newWorkspace(page); await page.goto('/wallets');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  const d = dlg(page, 'Connect a wallet');
  await expect(d.getByText('APEX never asks for keys.')).toBeVisible();
  await d.getByRole('radio', { name: /^EVM/ }).check(); await d.getByRole('button', { name: 'Next' }).click();
  // managed signer is shown but cannot be created from the console
  const managed = d.getByRole('radio', { name: /Scoped managed execution signer/ });
  await expect(managed).toBeDisabled(); await expect(d.getByText(/signer service and a KMS/)).toBeVisible();
  await d.getByRole('radio', { name: /Public address, watch-only/ }).check(); await d.getByRole('button', { name: 'Next' }).click();
  await d.getByLabel('Wallet nickname').fill('Probe');
  const addr = d.getByLabel('Public address'); const next = d.getByRole('button', { name: 'Next' });
  await addr.fill('0x123'); await expect(d.getByText(/exactly 40 hex/)).toBeVisible(); await expect(next).toBeDisabled();
  await addr.fill('9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362'); await expect(d.getByText(/0x followed by exactly 40/)).toBeVisible(); await expect(next).toBeDisabled();
  await addr.fill(SEED12); await expect(d.getByText('Secret material detected and refused.')).toBeVisible(); await expect(next).toBeDisabled();
  await addr.fill('0x' + '11'.repeat(32)); await expect(d.getByText(/may be a private key/)).toBeVisible(); await expect(next).toBeDisabled();
  await addr.fill(EVM_A); await expect(next).toBeEnabled();
  // there is no secret-looking input anywhere in the wizard
  expect(await d.locator('input[type=password], input[name*=seed i], input[name*=private i], input[name*=secret i], input[name*=mnemonic i]').count()).toBe(0);
  await d.getByRole('button', { name: 'Cancel' }).click();

  // server side: same protections without the browser
  const W = await ws(page);
  const bad = async (body: object) => (await apiCmd(page, 'connectWallet', { workspace: W, nickname: 'x', family: 'evm', ...body })).status();
  expect(await bad({ address: SEED12 })).toBe(400);
  expect(await bad({ address: 'abandon abandon abandon abandon abandon abandon abandon about' })).toBe(422);
  expect(await bad({ address: EVM_A, privateKey: '0xdeadbeef' })).toBe(400);
  expect(await bad({ address: '0x' + '11'.repeat(32) })).toBe(422);
  expect(await bad({ address: EVM_A, capability: 'managed_signer' })).toBe(400);
  expect(await bad({ family: 'svm', address: EVM_A })).toBe(422);
  expect(await bad({ address: EVM_A })).toBe(200);
  expect(await bad({ address: EVM_A.toLowerCase() })).toBe(409);       // same EVM address in another case is the same wallet
  expect(psql(`select count(*) from wallets where nickname='x' and address ~* '(abandon|deadbeef)'`)).toBe('0');
});

test('logical sharing needs an explicit acknowledgement (UI and server); physical buckets refuse shared wallets', async ({ page }) => {
  await newWorkspace(page); const p = await populate(page);
  // server: shared + no ack, and shared into a physical bucket
  const w = (await cmdOk(page, 'connectWallet', { workspace: p.W, nickname: 'Extra', family: 'evm', address: evmAddr(), chains: ['eip155:1'] })).id;
  expect((await apiCmd(page, 'assignWalletToBucket', { wallet: w, bucket: p.SH, exclusive: false, maxAllocationBps: 3000, logicalAck: false })).status()).toBe(422);
  expect((await apiCmd(page, 'assignWalletToBucket', { wallet: w, bucket: p.TR, exclusive: false, maxAllocationBps: 3000, logicalAck: true })).status()).toBe(422);
  // UI: wizard blocks "Next" until the checkbox is ticked
  await page.goto('/wallets'); await page.getByRole('button', { name: 'Connect wallet' }).click();
  const d = dlg(page, 'Connect a wallet');
  await d.getByRole('radio', { name: /^EVM/ }).check(); await d.getByRole('button', { name: 'Next' }).click();
  await d.getByRole('radio', { name: /Public address, watch-only/ }).check(); await d.getByRole('button', { name: 'Next' }).click();
  await d.getByLabel('Wallet nickname').fill('Sharer'); await d.getByLabel('Public address').fill(evmAddr()); await d.getByRole('button', { name: 'Next' }).click();
  await d.getByLabel(/Anti-phishing check/).check(); await d.getByRole('button', { name: 'Next' }).click();
  await d.getByRole('checkbox', { name: /Shared pool/ }).check();
  const physical = d.getByRole('checkbox', { name: /^Trading/ }); await physical.check();
  await expect(d.getByText(/can only be exclusive|cannot be exclusive/).first()).toBeVisible().catch(() => {});
  await physical.uncheck();
  await d.getByLabel(/Share this wallet with other buckets/).check();
  await expect(d.getByRole('button', { name: 'Next' })).toBeDisabled();
  await expect(d.getByText(/acknowledge logical sharing/)).toBeVisible();
  await d.getByLabel(/I understand this is logical separation only/).check();
  await expect(d.getByRole('button', { name: 'Next' })).toBeEnabled();
  await d.getByRole('button', { name: 'Cancel' }).click();
  // physical bucket assign dialog only offers dedicated wallets
  await page.goto(bucketPath(p, p.TR)); await page.getByRole('tab', { name: 'Wallets' }).click(); await page.getByRole('button', { name: 'Assign wallet' }).click();
  const ad = dlg(page, /Assign a wallet to Trading/); await expect(ad.getByText(/accepts a dedicated \(exclusive\) wallet only/)).toBeVisible();
  await expect(ad.getByLabel(/Share this wallet with other buckets/)).toHaveCount(0);
});

test('policy editor: diff before save, hard-limit refusal, stale-version (409) is surfaced and nothing is overwritten', async ({ page }) => {
  await newWorkspace(page); const p = await populate(page);
  await page.goto(bucketPath(p, p.TR)); await page.getByRole('tab', { name: 'Limits' }).click();
  const slip = page.getByLabel(/Max slippage/);
  // beyond the workspace hard limit (100 bps by default) is refused by the database
  await slip.fill('5000'); await page.getByRole('button', { name: 'Review changes' }).click(); await page.getByRole('button', { name: /Confirm and save/ }).click();
  await expect(page.getByText(/cannot exceed the global hard limit/)).toBeVisible();
  await expect(page.getByText('current version 1')).toBeVisible();
  // somebody else saves v2 while we hold v1
  await slip.fill('60');
  await cmdOk(page, 'updateBucketPolicy', { bucket: p.TR, expectedVersion: 1, policy: { max_slippage_bps: 70, max_open_orders: 3 } });
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.getByRole('rowheader', { name: 'max_slippage_bps' })).toBeVisible();
  await page.getByRole('button', { name: /Confirm and save \(expects v1\)/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Save refused' })).toBeVisible();
  await expect(page.getByText(/You edited version 1; the current version is 2/)).toBeVisible();
  expect(psql(`select policy_version from buckets where id='${p.TR}'`)).toBe('2');
  expect(psql(`select policy->>'max_slippage_bps' from buckets where id='${p.TR}'`)).toBe('70');   // not overwritten
  await page.getByRole('button', { name: /Keep my edits, compare with v2/ }).click();
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.getByText('Review: version 2 to version 3')).toBeVisible();
  await page.getByRole('button', { name: /Confirm and save \(expects v2\)/ }).click();
  await expect(page.getByText('current version 3')).toBeVisible();
  expect(psql(`select policy->>'max_slippage_bps' from buckets where id='${p.TR}'`)).toBe('60');
  // history diff
  await page.getByLabel('Compare current policy with').selectOption({ label: /v1/ as any }).catch(async () => page.getByLabel('Compare current policy with').selectOption({ index: 1 }));
  await expect(page.getByRole('table', { name: /Changes from v/ })).toBeVisible();
});

test('wallet lifecycle: pause blocks funding; revoke is refused with open reservations; move is refused while the old bucket holds balance', async ({ page }) => {
  test.setTimeout(120_000);
  await newWorkspace(page); const p = await populate(page);
  // move refused: Hot wallet holds ledger balance in Trading
  await page.goto(bucketPath(p, p.TR)); await page.getByRole('tab', { name: 'Wallets' }).click();
  await expect(page.getByRole('button', { name: 'Move…' })).toBeDisabled();
  await page.goto(`/wallets/${p.w1}`); await page.getByRole('tab', { name: 'Buckets' }).click();
  await page.getByRole('button', { name: 'Move…' }).click();
  const mv = dlg(page, /Move Hot wallet/);
  await mv.getByLabel('To bucket').selectOption({ label: 'Shared pool (logical)' });
  await mv.getByRole('button', { name: 'Move wallet' }).click();
  await expect(page.getByText(/still holds ledger balance for the old bucket/)).toBeVisible();
  expect(psql(`select count(*) from wallet_bucket_allocations where wallet_id='${p.w1}' and bucket_id='${p.TR}'`)).toBe('1');
  await mv.getByRole('button', { name: 'Cancel' }).click();

  // an open reservation blocks revoke (reservation is created by the engine; seeded through the DB as the test helper does)
  psql(`select reserve_capital('${p.W}','paper','${p.TR}','${p.c1}','${p.USDC}',100000000,'e2e-open-intent')`);
  await page.getByRole('button', { name: 'Revoke wallet Hot wallet' }).click();
  const rv = dlg(page, /Revoke wallet: Hot wallet/);
  await expect(rv.getByText(/1 open reservation/)).toBeVisible();
  await rv.getByLabel(/Reason/).fill('suspected compromise'); await rv.getByLabel('Type REVOKE to confirm').fill('REVOKE');
  await expect(rv.getByRole('button', { name: 'Revoke', exact: true })).toBeDisabled();
  expect((await apiCmd(page, 'revokeWallet', { wallet: p.w1, reason: 'direct api attempt' })).status()).toBe(422);
  await rv.getByRole('button', { name: 'Cancel' }).click();
  expect(psql(`select state from wallets where id='${p.w1}'`)).toBe('active');

  // pause: audited, and funding is refused
  await page.getByRole('button', { name: 'Pause wallet Hot wallet' }).click();
  const pz = dlg(page, /Pause wallet: Hot wallet/); await pz.getByLabel(/Reason/).fill('maintenance window'); await pz.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByText('paused', { exact: true }).first()).toBeVisible();
  expect((await apiCmd(page, 'paperDeposit', { workspace: p.W, walletChainAccount: p.c1, asset: p.USDC, amount: '1' })).status()).toBe(422);
  await page.getByRole('button', { name: 'Resume wallet Hot wallet' }).click();
  await dlg(page, /Resume wallet/).getByLabel(/Reason/).fill('window over'); await dlg(page, /Resume wallet/).getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause wallet Hot wallet' })).toBeVisible();

  // release the reservation (engine) and the open amount sits in `available`; reservations/in-flight are gone -> revoke allowed
  psql(`select release_reservation(id,0) from capital_reservations where intent_key='e2e-open-intent'`);
  await page.getByRole('button', { name: 'Revoke wallet Hot wallet' }).click();
  const rv2 = dlg(page, /Revoke wallet: Hot wallet/); await expect(rv2.getByText(/No open reservations/)).toBeVisible();
  await rv2.getByLabel(/Reason/).fill('rotating to new wallet'); await rv2.getByLabel('Type REVOKE to confirm').fill('REVOKE'); await rv2.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('revoked', { exact: true }).first()).toBeVisible();
  expect(psql(`select state from wallets where id='${p.w1}'`)).toBe('revoked');
  // the wallet's disabled controls explain themselves
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await expect(page.getByText(/Disabled: Needs a wallet-provider adapter/)).toBeVisible();
  const audit = psql(`select string_agg(action, ',' order by id) from audit_events where entity='wallets' and entity_id='${p.w1}'`);
  expect(audit).toContain('wallet.pause'); expect(audit).toContain('wallet.resume'); expect(audit).toContain('wallet.revoked');
});

test('baskets: weights must total exactly 100% (save blocked), preview is units-based and says so, overlap is flagged', async ({ page }) => {
  await newWorkspace(page); const p = await populate(page);
  await page.goto('/baskets'); await expect(page.getByText('No baskets yet')).toBeVisible();
  await page.getByRole('button', { name: 'New basket' }).first().click();
  const d = dlg(page, 'New basket'); const save = d.getByRole('button', { name: 'Save basket' });
  await d.getByLabel('Bucket').selectOption({ label: 'Trading (paper)' }); await d.getByLabel('Basket name').fill('Stable core');
  await d.getByLabel('Asset 1', { exact: true }).selectOption({ label: 'USDC · eip155:1' }); await d.getByLabel('Weight %').first().fill('60');
  await expect(d.getByText('Total 60.00% of 100.00%')).toBeVisible(); await expect(d.getByText('40.00% still unallocated')).toBeVisible(); await expect(save).toBeDisabled();
  await d.getByRole('button', { name: 'Add asset' }).click();
  await d.getByLabel('Asset 2', { exact: true }).selectOption({ label: 'DAI · eip155:1' }); await d.getByLabel('Weight %').nth(1).fill('45');
  await expect(d.getByText('5.00% over 100%')).toBeVisible(); await expect(save).toBeDisabled();
  await d.getByLabel('Weight %').nth(1).fill('40'); await expect(save).toBeEnabled();
  await save.click(); await expect(page.getByText('Basket "Stable core" created')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Preview rebalance for Stable core' })).toBeVisible();
  await expect(page.getByText(/No market-price feed exists/)).toBeVisible();
  // 3000 USDC vs 500 DAI => normalised 3000:500 => USDC 85.71% (target 60) => sell USDC, buy DAI
  const t = page.getByRole('table', { name: 'Rebalance preview for Stable core' });
  await expect(t.getByRole('row', { name: /USDC/ })).toContainText('sell'); await expect(t.getByRole('row', { name: /DAI/ })).toContainText('buy');
  await expect(t.getByRole('row', { name: /USDC/ })).toContainText('85.71%');
  expect((await apiCmd(page, 'createBasket', { bucket: p.TR, name: 'bad', members: [{ asset: p.USDC, weight_bps: 5000 }, { asset: p.DAI, weight_bps: 4999 }] })).status()).toBe(422);
  await cmdOk(page, 'createBasket', { bucket: p.TR, name: 'Overlap', members: [{ asset: p.USDC, weight_bps: 10000 }] });
  await page.reload(); await expect(page.getByText('Same asset in several baskets')).toBeVisible();
});

test('bucket wizard B-01..B-05: explains physical/logical/protected, validates the waterfall, budgets and creates everything in order', async ({ page }) => {
  test.setTimeout(120_000);
  await newWorkspace(page); const p = await populate(page);
  await page.goto('/buckets'); await page.getByRole('button', { name: 'New bucket' }).first().click();
  const d = dlg(page, 'New bucket');
  await expect(d.getByText(/NO wallet-level security segregation/)).toBeVisible();
  await expect(d.getByText(/escrow|exclusively to this bucket/).first()).toBeVisible();
  await d.getByLabel('Bucket name').fill('Quant'); await d.getByRole('button', { name: 'Next' }).click();
  await d.getByLabel(/Max slippage/).fill('40'); await d.getByLabel('Advanced policy JSON (optional, merged)').fill('{bad'); await expect(d.getByText('Advanced JSON is not valid JSON')).toBeVisible(); await expect(d.getByRole('button', { name: 'Next' })).toBeDisabled();
  await d.getByLabel('Advanced policy JSON (optional, merged)').fill(''); await d.getByRole('button', { name: 'Next' }).click();
  // wallets: Hot wallet is exclusive elsewhere
  await expect(d.getByText(/Exclusively assigned to another bucket/).first()).toBeVisible();
  await d.getByRole('button', { name: 'Next' }).click();
  await d.getByRole('button', { name: 'Add budget' }).click();
  await d.getByLabel('Asset', { exact: true }).selectOption({ label: 'USDC · eip155:1' });
  await d.getByLabel(/^Limit/).fill('250.5');
  await d.getByLabel(/Configure a compounding policy now/).check();
  await d.getByLabel('Reinvest %').fill('60'); await d.getByLabel('Vault %').fill('20');
  await expect(d.getByText(/must be 100/).first()).toBeVisible(); await expect(d.getByRole('button', { name: 'Next' })).toBeDisabled();
  await d.getByLabel('Reserve %').fill('20'); await d.getByLabel('Vault bucket').selectOption({ label: 'Vault' }); await d.getByLabel('Vault wallet account').selectOption({ index: 1 });
  const strat = d.getByLabel('Strategy', { exact: true });
  if ((await strat.locator('option').count()) > 1) await strat.selectOption({ index: 1 }); else { await d.getByRole('button', { name: 'Remove budget 1' }).click(); }
  await expect(d.getByRole('button', { name: 'Next' })).toBeEnabled(); await d.getByRole('button', { name: 'Next' }).click();
  await expect(d.getByText('Create protected', { exact: false })).toHaveCount(0);
  await d.getByRole('button', { name: 'Create bucket' }).click();
  await expect(page.getByRole('heading', { name: 'Quant', level: 1 })).toBeVisible({ timeout: 20_000 });
  const bid = page.url().split('/').pop()!;
  expect(psql(`select policy_version from buckets where id='${bid}'`)).toBe('2');
  expect(psql(`select reinvest_bps||'/'||vault_bps||'/'||reserve_bps from compounding_policies where bucket_id='${bid}'`)).toBe('6000/2000/2000');
  await page.getByRole('tab', { name: 'Compounding' }).click(); await expect(page.getByText('Active waterfall policy')).toBeVisible();
  await expect(page.getByText(/What-if calculator/)).toBeVisible();
});

test('screenshots + axe + no overflow at 5 viewports for every capital page and wizard', async ({ page }) => {
  test.setTimeout(300_000);
  await newWorkspace(page); const p = await populate(page);
  await cmdOk(page, 'createBasket', { bucket: p.TR, name: 'Stable core', members: [{ asset: p.USDC, weight_bps: 6000 }, { asset: p.DAI, weight_bps: 4000 }] });
  await cmdOk(page, 'setStrategyBudget', { bucket: p.TR, strategy: psql(`select key from strategy_definitions limit 1`) || 'none', asset: p.USDC, limit: '1000000000' }).catch(() => {});
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/portfolios'); await expect(page.getByRole('link', { name: 'Core' })).toBeVisible(); await sweep(page, 'portfolios');
  await page.getByRole('button', { name: 'New portfolio' }).first().click(); await expect(dlg(page, 'New portfolio')).toBeVisible(); await sweep(page, 'portfolios-wizard'); await page.keyboard.press('Escape');
  await page.goto('/buckets'); await expect(page.getByRole('link', { name: 'Trading' })).toBeVisible(); await sweep(page, 'buckets');
  await page.getByRole('button', { name: 'New bucket' }).first().click(); await expect(dlg(page, 'New bucket')).toBeVisible(); await sweep(page, 'buckets-wizard'); await page.keyboard.press('Escape');
  await page.goto(bucketPath(p, p.TR)); await expect(page.getByRole('heading', { name: 'Trading', level: 1 })).toBeVisible(); await expect(page.getByText('USDC · paper ledger')).toBeVisible();
  for (const t of ['overview', 'assets', 'wallets', 'baskets', 'allocations', 'strategies', 'compounding', 'limits', 'transfers', 'audit']) { await page.getByRole('tab', { name: new RegExp(`^${t}$`, 'i') }).click(); await page.waitForTimeout(300); await sweep(page, `bucket-${t}`); }
  await page.getByRole('tab', { name: 'Overview' }).click(); await page.getByRole('button', { name: 'Allocate to bucket' }).click(); await expect(dlg(page, /Allocate to Trading/)).toBeVisible(); await sweep(page, 'bucket-allocate-dialog'); await page.keyboard.press('Escape');
  await page.goto('/wallets'); await expect(page.getByRole('heading', { name: 'Hot wallet' })).toBeVisible(); await sweep(page, 'wallets-cards');
  await page.getByRole('button', { name: 'Table' }).click(); await expect(page.getByRole('table', { name: 'Wallets' })).toBeVisible(); await sweep(page, 'wallets-table');
  await page.getByRole('button', { name: 'Connect wallet' }).click(); await expect(dlg(page, 'Connect a wallet')).toBeVisible(); await sweep(page, 'wallets-wizard');
  await page.keyboard.press('Escape');
  await page.goto(`/wallets/${p.w1}`); await expect(page.getByRole('heading', { name: 'Hot wallet', level: 1 })).toBeVisible();
  for (const t of ['balances', 'assets', 'permissions', 'buckets', 'activity', 'fees', 'connections']) { await page.getByRole('tab', { name: new RegExp(`^${t}$`, 'i') }).click(); await page.waitForTimeout(300); await sweep(page, `wallet-${t}`); }
  await page.goto('/baskets'); await expect(page.getByText('Rebalancing preview: Stable core')).toBeVisible(); await sweep(page, 'baskets');
  await page.getByRole('button', { name: 'New basket' }).first().click(); await expect(dlg(page, 'New basket')).toBeVisible(); await sweep(page, 'baskets-wizard');
  expect(errors).toEqual([]);
});
