import { expect, test } from '@playwright/test';
import { createWorkspaceIfNeeded, login } from './helpers';
import { apiGet, sql, sweep, world } from './trading-helpers';

test.describe('live orders (APEX-007)', () => {
  test('empty states, paper ticket waits for the risk service (no bypass), persists, timeline, cancel, UNKNOWN highlight, axe', async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
    await login(page); await createWorkspaceIfNeeded(page); await page.goto('/dashboard');
    const w = await world(page);
    await page.goto('/trading');
    await expect(page.getByRole('heading', { name: 'Live Orders', level: 1 })).toBeVisible();
    await expect(page.getByText('No orders yet')).toBeVisible(); await expect(page.getByText('Live is locked behind the deployment gates')).toBeVisible();
    await page.getByRole('tab', { name: 'Positions' }).click(); await expect(page.getByText('No positions')).toBeVisible();
    await page.getByRole('tab', { name: 'Fills' }).click(); await expect(page.getByText('No fills yet')).toBeVisible();
    await page.getByRole('tab', { name: 'Orders' }).click();

    // ticket: validation, then create
    await page.getByRole('button', { name: 'New paper order' }).click(); const d = page.getByRole('dialog');
    await expect(d.getByText('PAPER only.')).toBeVisible();
    await d.getByRole('button', { name: 'Create paper intent' }).click(); await expect(d.getByText('Choose a paper bucket')).toBeVisible();
    await d.getByLabel('Paper bucket').selectOption(w.bucket); await d.getByLabel(/Wallet account/).selectOption(w.wca);
    await d.getByLabel('Base asset').selectOption(w.eth); await d.getByLabel('Quote asset').selectOption(w.usdc);
    await expect(d.getByText(/Available in this bucket: 1,?000 USDC/)).toBeVisible();
    await d.getByLabel(/^Quantity/).fill('0.5'); await d.getByLabel(/Quote budget/).fill('999999'); await d.getByRole('button', { name: 'Create paper intent' }).click();
    await expect(page.getByText(/insufficient available balance/i)).toBeVisible();     // refused by the database, not the page
    await d.getByLabel(/Quote budget/).fill('100.25'); await d.getByLabel(/^Quantity/).fill('0.05'); await d.getByRole('button', { name: 'Create paper intent' }).click();
    await expect(page.getByText('Paper intent created: waiting for the risk service')).toBeVisible();
    const row = page.getByRole('row', { name: /RISK_EVALUATING/ }); await expect(row).toBeVisible();
    await expect(row).toContainText('Waiting for the risk service'); await expect(row).toContainText('Paper'); await expect(row).toContainText('0.05 ETH');
    await expect(row).toContainText('—');                                  // slippage / gas not recorded
    await expect(page.getByText('waiting for the risk service', { exact: false }).first()).toBeVisible();
    // persisted + still unadmitted
    await page.reload(); await expect(page.getByRole('row', { name: /RISK_EVALUATING/ })).toBeVisible();
    expect(sql(`select count(*) from risk_decisions where workspace_id='${w.ws}'`)).toBe('0');
    expect(sql(`select state from trade_intents where workspace_id='${w.ws}'`)).toBe('RISK_EVALUATING');

    // drawer: timeline from recorded events only
    await page.getByRole('button', { name: /View order/ }).click(); const dr = page.getByRole('dialog');
    const tl = dr.getByRole('list', { name: /Order timeline/ }); await expect(tl).toBeVisible();
    await expect(tl.locator('li[aria-current=step]')).toContainText('RISK_EVALUATING'); await expect(tl.getByText('not reached').first()).toBeVisible();
    await expect(dr.getByText('No fills recorded.')).toBeVisible();
    await sweep(page, 'trading-drawer');
    // cancel (before SUBMITTING) -> CANCELLED persisted
    await dr.getByRole('button', { name: 'Cancel order' }).click(); await page.getByRole('dialog').last().getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByText('Order cancelled')).toBeVisible();
    await page.reload(); await expect(page.getByRole('row', { name: /CANCELLED/ })).toBeVisible();
    expect(sql(`select count(*) from audit_events where workspace_id='${w.ws}' and action='intent.cancel'`)).toBe('1');

    // UNKNOWN is highlighted with the reconciliation message; a submitted order offers no cancel
    const id = (await apiGet(page, `v1/orders/board?workspace=${w.ws}`)).items[0].id;
    sql(`update trade_intents set state='UNKNOWN' where id='${id}'`);
    await page.reload(); await expect(page.getByRole('row', { name: /UNKNOWN/ })).toContainText('Awaiting reconciliation — will never be blindly retried');
    await page.getByRole('button', { name: /View order/ }).click(); await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await sweep(page, 'trading');
    expect(errors).toEqual([]);
  });

  test('positions and fills show only recorded values; unrealised PnL is not priced; env badges separate paper', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page); await createWorkspaceIfNeeded(page); await page.goto('/dashboard');
    const w = await world(page);
    await page.goto('/trading'); await page.getByRole('button', { name: 'New paper order' }).click(); const d = page.getByRole('dialog');
    await d.getByLabel('Paper bucket').selectOption(w.bucket); await d.getByLabel(/Wallet account/).selectOption(w.wca); await d.getByLabel('Base asset').selectOption(w.eth); await d.getByLabel('Quote asset').selectOption(w.usdc);
    await d.getByLabel(/^Quantity/).fill('0.1'); await d.getByLabel(/Quote budget/).fill('300'); await d.getByRole('button', { name: 'Create paper intent' }).click(); await expect(page.getByText('Paper intent created')).toBeVisible();
    const id = sql(`select id from trade_intents where workspace_id='${w.ws}'`);
    // play the engine/risk service for this one intent through the real DB functions
    sql(`select set_config('apex.service','on',false); insert into risk_decisions(intent_id,workspace_id,decision,reasons,policy_version,evaluator) values ('${id}','${w.ws}','ADMIT','[]',1,'e2e-risk');
         select advance_intent('${id}','ADMITTED','e:a'); select reserve_for_intent('${id}'); select advance_intent('${id}','CAPITAL_RESERVED','e:r'); select advance_intent('${id}','QUOTED','e:q'); select advance_intent('${id}','PREPARED','e:p');
         select advance_intent('${id}','SUBMITTING','e:s'); select advance_intent('${id}','ACKNOWLEDGED','e:k'); select apply_fill_checked('${id}','fill-1',100000000000000000,290000000,1500000);`);
    await page.reload();
    await expect(page.getByRole('row', { name: /PARTIALLY|ACKNOWLEDGED/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /ACKNOWLEDGED/ })).toContainText('100.00%');
    await page.getByRole('tab', { name: 'Fills' }).click(); const fr = page.getByRole('row', { name: /0\.1/ }); await expect(fr).toContainText('290'); await expect(fr).toContainText('Paper');
    await page.getByRole('tab', { name: 'Positions' }).click(); await expect(page.getByRole('cell', { name: 'Not priced (no feed)' })).toBeVisible(); await expect(page.getByText('Unrealised PnL is not computed')).toBeVisible();
    await sweep(page, 'trading-positions');
  });
});
