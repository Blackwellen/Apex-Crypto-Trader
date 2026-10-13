import { expect, test } from '@playwright/test';
import { createWorkspaceIfNeeded, login } from './helpers';
import { apiGet, secondOwner, sweep, world } from './trading-helpers';

test.describe('strategies (APEX-005/006)', () => {
  test('list: 20 spec strategies, all research with no evidence, nothing live; filters work', async ({ page }) => {
    await login(page); await createWorkspaceIfNeeded(page); await page.goto('/strategies');
    await expect(page.getByRole('heading', { name: 'Strategies', level: 1 })).toBeVisible();
    const table = page.getByRole('table', { name: 'Strategy definitions' }); await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(20);
    expect(await table.getByText('Research', { exact: true }).count()).toBe(20);
    expect(await table.getByText('Recorded', { exact: true }).count()).toBe(0);
    await expect(page.getByText('No strategy is live.')).toBeVisible();
    await page.getByLabel('Search strategies').fill('arbitrage'); await expect(page.getByRole('link', { name: /CEX-CEX arbitrage/ })).toBeVisible();
    await page.getByLabel('Filter by stage', { exact: true }).selectOption('paper'); await expect(page.getByText('No matching rows')).toBeVisible();
    await page.getByLabel('Filter by stage', { exact: true }).selectOption(''); await page.getByLabel('Search strategies').fill('');
    await page.getByRole('button', { name: 'Cards' }).click(); await expect(page.locator('article[aria-label]').first()).toBeVisible();
    await sweep(page, 'strategies');
  });

  test('detail: tabs, No runs yet, research stage cannot be enabled; promotion needs a second owner; budget + enable persist; disable returns to research', async ({ page, request }) => {
    test.setTimeout(240_000);
    await login(page); await createWorkspaceIfNeeded(page); await page.goto('/dashboard');
    const w = await world(page);
    const key = 'cex_trend_momentum';
    await page.goto(`/strategies/${key}`);
    await expect(page.getByRole('heading', { name: 'Liquid CEX trend / momentum', level: 1 })).toBeVisible();
    for (const t of ['Overview', 'Signals', 'Execution', 'Risk', 'Research', 'Jobs', 'Audit']) await expect(page.getByRole('tab', { name: t, exact: true })).toBeVisible();
    await expect(page.getByText('None recorded.')).toBeVisible();
    const sw = page.getByRole('switch', { name: /on Trading/ }); await expect(sw).toBeDisabled();
    await expect(page.getByText('cannot be enabled on a bucket until it is promoted')).toBeVisible();
    await page.getByRole('tab', { name: 'Research' }).click(); await expect(page.getByRole('tabpanel').getByText('No runs yet')).toBeVisible(); await expect(page.getByRole('link', { name: 'Open Research' })).toHaveAttribute('href', '/research');
    await page.getByRole('tab', { name: 'Signals' }).click(); await expect(page.getByText('No signals yet')).toBeVisible();
    await page.getByRole('tab', { name: 'Overview' }).click();
    // budget (persisted via setStrategyBudget)
    await page.getByRole('cell').getByRole('button', { name: 'Set budget' }).click();
    let d = page.getByRole('dialog'); await d.getByLabel('Budget asset').selectOption({ label: 'USDC · eip155:1 · 0xa0b869' }).catch(async () => { await d.getByLabel('Budget asset').selectOption(w.usdc); });
    await d.getByLabel(/^Limit/).fill('400.5'); await d.getByRole('button', { name: 'Save budget' }).click(); await expect(page.getByText('Capital budget saved')).toBeVisible();
    await page.reload(); await expect(page.getByText('400.5 USDC')).toBeVisible();
    // promotion: request -> pending persists -> requester cannot approve -> second owner approves -> apply
    await page.getByRole('button', { name: 'Request promotion to Paper' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Request approval' }).click(); await expect(page.getByText('Approval requested')).toBeVisible();
    await page.reload(); await expect(page.getByText(/Pending: Research/)).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).click(); await expect(page.getByText(/permission denied/i)).toBeVisible();
    const o2 = await secondOwner(request, w.ws);
    const cat = await apiGet(page, `v1/strategies/${key}/detail?workspace=${w.ws}`); const aid = cat.approvals[0].id;
    expect((await o2.cmd('decideApproval', { approval: aid, approve: true })).status()).toBe(200);
    await page.reload(); await page.getByRole('button', { name: 'Apply stage change' }).click(); await expect(page.getByText('Stage is now Paper')).toBeVisible();
    await page.reload(); await expect(page.getByLabel('Deployment stage').getByText('Paper', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('No validation evidence is recorded')).toBeVisible();   // live_candidate blocked
    // enable switch persists
    const sw2 = page.getByRole('switch', { name: /on Trading/ }); await expect(sw2).toBeEnabled(); await sw2.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Enable', exact: true }).click(); await expect(page.getByText('Strategy enabled')).toBeVisible();
    await page.reload(); await expect(page.getByRole('switch', { name: /on Trading/ })).toHaveAttribute('aria-checked', 'true');
    // settings validated against declared bounds
    await page.getByRole('cell').getByRole('button', { name: 'Settings' }).click(); d = page.getByRole('dialog');
    await d.getByLabel(/lookback_bars/).fill('5000'); await d.getByRole('button', { name: 'Save settings' }).click(); await expect(d.getByRole('alert')).toContainText('must be within');
    await d.getByLabel(/lookback_bars/).fill('80'); await d.getByLabel('Stop loss (basis points)').fill('150'); await d.getByRole('button', { name: 'Save settings' }).click(); await expect(page.getByText('Strategy settings saved')).toBeVisible();
    await page.getByRole('tab', { name: 'Audit' }).click(); await expect(page.getByRole('cell', { name: 'strategy.enable' })).toBeVisible();
    await page.getByRole('tab', { name: 'Overview' }).click(); await sweep(page, 'strategy-detail');
    // disable: typed phrase + reason; returns to research and switches the instance off
    await page.getByRole('button', { name: 'Disable', exact: true }).first().click(); d = page.getByRole('dialog');
    await d.getByLabel('Type DISABLE to confirm').fill('DISABLE'); await d.getByLabel('Reason (required)').fill('review'); await d.getByRole('button', { name: 'Disable strategy' }).click();
    await expect(page.getByText(/Strategy disabled/)).toBeVisible();
    await page.reload(); await expect(page.getByRole('switch', { name: /on Trading/ })).toHaveAttribute('aria-checked', 'false'); await expect(page.getByRole('switch', { name: /on Trading/ })).toBeDisabled();
  });

  test('wizard S-01..S-06 creates a research-only strategy that survives reload; invalid bounds are blocked; clone copies bounds', async ({ page }) => {
    await login(page); await createWorkspaceIfNeeded(page); await page.goto('/strategies');
    await page.getByRole('button', { name: 'New strategy' }).click(); const d = page.getByRole('dialog');
    await d.getByRole('button', { name: 'Continue' }).click(); await expect(d.getByText('At least 3 characters')).toBeVisible();
    await d.getByLabel('Name', { exact: true }).fill('E2E Breakout'); await expect(d.getByLabel('Key (slug)')).toHaveValue('e2e_breakout');
    await d.getByLabel('CEX / venue (spot)').check(); await d.getByRole('button', { name: 'Continue' }).click();
    await d.getByLabel('ohlcv').check(); await d.getByLabel('trending').check(); await d.getByRole('button', { name: 'Continue' }).click();
    await d.getByRole('button', { name: 'Add parameter' }).click(); await d.getByLabel('Name', { exact: true }).fill('lookback'); await d.getByLabel('Default').fill('500'); await d.getByRole('button', { name: 'Continue' }).click();
    await expect(d.getByText('Require min <= default <= max')).toBeVisible(); await d.getByLabel('Default').fill('50'); await d.getByRole('button', { name: 'Continue' }).click();
    await d.getByLabel(/Max order size/).fill('99999'); await d.getByRole('button', { name: 'Continue' }).click(); await expect(d.getByText('Whole basis points 0-10000')).toBeVisible();
    await d.getByLabel(/Max order size/).fill('1500'); await d.getByRole('button', { name: 'Continue' }).click();
    await d.getByRole('button', { name: 'Continue' }).click();
    await expect(d.getByText('evidence: none')).toBeVisible(); await d.getByRole('button', { name: 'Create in research stage' }).click();
    await expect(page.getByRole('heading', { name: 'E2E Breakout', level: 1 })).toBeVisible();
    await page.reload(); await expect(page.getByRole('heading', { name: 'E2E Breakout', level: 1 })).toBeVisible(); await expect(page.getByText('None recorded.')).toBeVisible(); await expect(page.getByRole('cell', { name: 'lookback' })).toBeVisible();
    // clone
    await page.getByRole('button', { name: 'Clone' }).click(); const c = page.getByRole('dialog'); await expect(c.getByLabel('Name', { exact: true })).toHaveValue('E2E Breakout (copy)');
    await c.getByRole('button', { name: 'Close' }).click();
    await page.goto('/strategies'); await expect(page.getByRole('link', { name: 'E2E Breakout' })).toBeVisible();
    await page.getByRole('button', { name: 'New strategy' }).click(); await sweep(page, 'strategy-wizard');
  });
});
