import { expect, test } from '@playwright/test';
import { createWorkspaceIfNeeded, login } from './helpers';
import { sql, sweep, world } from './trading-helpers';

test.describe('execution (APEX-017)', () => {
  test('empty state is honest; with a recorded fill the waterfall, latency and attribution appear; gas/slippage stay unrecorded', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page); await createWorkspaceIfNeeded(page); await page.goto('/dashboard'); const w = await world(page);
    await page.goto('/execution'); await expect(page.getByRole('heading', { name: 'Execution', level: 1 })).toBeVisible();
    await expect(page.getByText('No latency recorded')).toBeVisible(); await expect(page.getByText('CEX / DEX quote comparator')).toBeVisible(); await expect(page.getByText('Jito / Flashbots defensive route health')).toBeVisible();
    await expect(page.getByText('No fills yet').first()).toBeVisible();
    await sweep(page, 'execution-empty');
    // one recorded fill via the real DB functions
    await page.goto('/trading'); await page.getByRole('button', { name: 'New paper order' }).click(); const d = page.getByRole('dialog');
    await d.getByLabel('Paper bucket').selectOption(w.bucket); await d.getByLabel(/Wallet account/).selectOption(w.wca); await d.getByLabel('Base asset').selectOption(w.eth); await d.getByLabel('Quote asset').selectOption(w.usdc);
    await d.getByLabel(/^Quantity/).fill('0.1'); await d.getByLabel(/Quote budget/).fill('300'); await d.getByRole('button', { name: 'Create paper intent' }).click(); await expect(page.getByText('Paper intent created')).toBeVisible();
    const id = sql(`select id from trade_intents where workspace_id='${w.ws}'`);
    sql(`select set_config('apex.service','on',false); insert into risk_decisions(intent_id,workspace_id,decision,reasons,policy_version,evaluator) values ('${id}','${w.ws}','ADMIT','[]',1,'e2e-risk');
         select advance_intent('${id}','ADMITTED','e:a'); select reserve_for_intent('${id}'); select advance_intent('${id}','CAPITAL_RESERVED','e:r'); select advance_intent('${id}','QUOTED','e:q'); select advance_intent('${id}','PREPARED','e:p');
         select advance_intent('${id}','SUBMITTING','e:s'); select advance_intent('${id}','ACKNOWLEDGED','e:k'); select apply_fill_checked('${id}','fill-1',100000000000000000,290000000,1500000);`);
    await page.goto('/execution'); const wf = page.getByRole('group', { name: 'Fee waterfall paper USDC' }); await expect(wf).toBeVisible();
    await expect(wf).toContainText('290 USDC'); await expect(wf).toContainText('1.5 USDC'); await expect(wf).toContainText('288.5 USDC'); await expect(wf).toContainText('not recorded');
    await expect(page.getByRole('img', { name: /Latency histogram/ })).toBeVisible(); await expect(page.getByText('NOT exchange wire-to-fill latency')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'manual_paper' }).first()).toBeVisible();
    await page.reload(); await expect(page.getByRole('group', { name: 'Fee waterfall paper USDC' })).toContainText('288.5 USDC');
    await sweep(page, 'execution');
  });
});
