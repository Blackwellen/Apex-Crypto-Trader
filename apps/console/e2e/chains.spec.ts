import { expect, test } from '@playwright/test';
import { createWorkspaceIfNeeded, login } from './helpers';
import { apiGet, sweep } from './trading-helpers';

test.describe('chains (APEX-015/016)', () => {
  test('cards show registry data; health is never green without samples; trading is never ready without CERTIFIED swap/submit', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
    await login(page); await createWorkspaceIfNeeded(page);
    await page.goto('/chains');
    await expect(page.getByRole('heading', { name: 'Chains', level: 1 })).toBeVisible();
    const ws = (await apiGet(page, 'v1/workspaces')).items[0].id;
    const ov = await apiGet(page, `v1/chains/overview?workspace=${ws}`);
    expect(ov.items.length, 'registry seeded by the chain-registry migrations').toBeGreaterThan(5);
    const cards = page.locator('article[aria-label]'); await expect(cards.first()).toBeVisible(); expect(await cards.count()).toBe(ov.items.length);
    // what the DB says is certified for trading (swap AND submit AND the rest) is exactly what the UI may call certified
    const TRADE = ['swap', 'submit', 'simulate', 'getFeeQuote', 'getTransactionStatus', 'finalityStatus', 'signThroughPolicyService'];
    const certified = ov.items.filter((c: any) => TRADE.every((k) => c.capabilities[k]?.status === 'CERTIFIED' && c.capabilities[k]?.evidence)).length;
    expect(await page.getByText('Trading: certified', { exact: true }).count()).toBe(certified);
    const measured = ov.items.filter((c: any) => c.health.status !== 'NOT_MEASURED').length;
    expect(await cards.getByText('Healthy', { exact: true }).count()).toBe(ov.items.filter((c: any) => c.health.status === 'HEALTHY').length);
    if (measured === 0) { await expect(cards.first().getByText('Not measured').first()).toBeVisible(); await expect(page.getByText('Chain health is Not measured')).toBeVisible(); }
    // card content
    const first = ov.items[0]; const card = page.locator(`article[aria-label="${first.name}"]`).first();
    await expect(card).toContainText(first.native_symbol); await expect(card).toContainText(first.finality_model); await expect(card).toContainText(/certified .* read-only/);
    // table view + filters
    await page.getByRole('button', { name: 'Table' }).click();
    await expect(page.getByRole('table', { name: 'Chain registry' })).toBeVisible();
    await page.getByLabel('Search Chain registry').fill('Arbitrum'); await expect(page.getByRole('row', { name: /Arbitrum One/ })).toBeVisible();
    await page.getByLabel('Search Chain registry').fill('');
    await page.getByRole('button', { name: 'Cards' }).click();
    await sweep(page, 'chains');
    expect(errors).toEqual([]);
  });

  test('enable (monitoring only) and disable (reason + typed confirmation) persist across reload and are audited', async ({ page }) => {
    await login(page); await createWorkspaceIfNeeded(page); await page.goto('/chains');
    const name = 'Arbitrum One'; const card = page.locator(`article[aria-label="${name}"]`);
    await expect(card).toContainText('Disabled');
    await card.getByRole('button', { name: `Enable ${name}` }).click();
    const dlg = page.getByRole('dialog'); await expect(dlg).toContainText('does not grant trading');
    await dlg.getByRole('button', { name: 'Enable monitoring' }).click();
    await expect(page.getByText(`${name} enabled for monitoring`)).toBeVisible();
    await page.reload(); await expect(page.locator(`article[aria-label="${name}"]`)).toContainText('Monitoring on');
    await expect(page.locator(`article[aria-label="${name}"]`).getByText(/Trading: (not ready|partial)/)).toBeVisible();   // enabling did not make it trade-ready
    // disable requires a reason and the typed phrase
    await page.locator(`article[aria-label="${name}"]`).getByRole('button', { name: `Disable ${name}` }).click();
    const d2 = page.getByRole('dialog'); const confirm = d2.getByRole('button', { name: 'Disable chain' }); await expect(confirm).toBeDisabled();
    await d2.getByLabel('Type DISABLE to confirm').fill('DISABLE'); await d2.getByLabel('Reason (required)').fill('x'); await confirm.click();
    await expect(page.getByText('A reason of at least 3 characters is required')).toBeVisible();
    await d2.getByLabel('Reason (required)').fill('planned RPC maintenance'); await confirm.click();
    await expect(page.getByText(`${name} disabled`)).toBeVisible();
    await page.reload(); await expect(page.locator(`article[aria-label="${name}"]`)).toContainText('Disabled');
    const ws = (await apiGet(page, 'v1/workspaces')).items[0].id;
    const audit = (await apiGet(page, `v1/audit?workspace=${ws}`)).items.map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['chain.enable', 'chain.disable']));
    const risk = await apiGet(page, `v1/risk?workspace=${ws}`); expect(risk.emergencies.some((e: any) => e.action === 'DISABLE_CHAIN' && e.scope_id === 'eip155:42161')).toBe(true);
  });

  test('chain detail: eight tabs, honest not-connected states, capability evidence, keyboard navigation, axe at 5 viewports', async ({ page }) => {
    await login(page); await createWorkspaceIfNeeded(page);
    await page.goto('/chains'); await page.locator('article[aria-label="Ethereum"] a').first().click().catch(async () => { await page.getByRole('link', { name: /Ethereum/ }).first().click(); });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Ethereum');
    for (const t of ['Nodes', 'Providers', 'Fees', 'Wallets', 'Markets', 'Transactions', 'Incidents', 'Adapters']) await expect(page.getByRole('tab', { name: t, exact: true })).toBeVisible();
    await expect(page.getByText('Not measured').first()).toBeVisible();
    await expect(page.getByText('Probing is not producing samples')).toBeVisible();
    await page.getByRole('tab', { name: 'Nodes' }).focus(); await page.keyboard.press('ArrowRight'); await expect(page.getByRole('tab', { name: 'Providers' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('No provider telemetry')).toBeVisible();
    await page.getByRole('tab', { name: 'Fees' }).click(); await expect(page.getByText('Gas price distribution: not available')).toBeVisible();
    await page.getByRole('tab', { name: 'Wallets' }).click(); await expect(page.getByText('No wallets on this chain')).toBeVisible();
    await page.getByRole('tab', { name: 'Markets' }).click(); await expect(page.getByRole('table', { name: 'Registered assets' })).toBeVisible();
    await page.getByRole('tab', { name: 'Transactions' }).click(); await expect(page.getByText('No orders on this chain')).toBeVisible();
    await page.getByRole('tab', { name: 'Incidents' }).click(); await expect(page.getByText('No incidents recorded')).toBeVisible();
    await page.getByRole('tab', { name: 'Adapters' }).click(); await expect(page.getByRole('table', { name: 'Adapter capability records' })).toBeVisible();
    await expect(page.getByRole('row', { name: /swap/ })).toBeVisible();
    // tab persists in the URL hash across reload
    await page.reload(); await expect(page.getByRole('tab', { name: 'Adapters' })).toHaveAttribute('aria-selected', 'true');
    for (const t of ['Nodes', 'Wallets', 'Adapters']) { await page.getByRole('tab', { name: t }).click(); await sweep(page, `chain-detail-${t.toLowerCase()}`); }
  });

  test('unknown chain id shows an error state, not a blank page', async ({ page }) => {
    await login(page); await createWorkspaceIfNeeded(page); await page.goto('/chains/nope%3A1');
    await expect(page.locator('[role=alert]').filter({ hasText: 'Could not load' })).toContainText(/not found/i);
  });
});
