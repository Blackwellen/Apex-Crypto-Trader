import { expect, test } from '@playwright/test';
import { login } from './helpers';
import { get, seedWorld, sql } from './ops-helpers';

test('risk: gate sign-off needs evidence + SHA, live stays locked, opt-in is high-friction; persists after reload', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page); const w = await seedWorld(page);
  await page.goto('/risk'); await expect(page.getByRole('heading', { name: 'Risk Command' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Current violations' })).toContainText('16 deployment gate(s) not PASS'); await expect(page.getByRole('table', { name: 'Current violations' })).toContainText('live_allowed()');
  await page.getByRole('button', { name: 'Sign off ledger_conservation' }).click();
  const d = page.getByRole('dialog'); const rec = d.getByRole('button', { name: 'Record PASS' });
  await expect(rec).toBeDisabled();
  await d.getByLabel(/Evidence reference/).fill('docs/evidence/runs/ledger.log'); await expect(rec).toBeDisabled();
  await d.getByLabel(/Commit SHA/).fill('not-hex'); await expect(rec).toBeDisabled(); await expect(d).toContainText('Hex characters only');
  await d.getByLabel(/Commit SHA/).fill('abc1234def'); await expect(rec).toBeEnabled(); await rec.dblclick();
  await expect(page.getByText('Gate ledger_conservation recorded as PASS')).toBeVisible();
  await page.reload();
  const gates = page.getByRole('table', { name: 'Deployment gates' }); await expect(gates).toContainText('docs/evidence/runs/ledger.log'); await expect(gates).toContainText('abc1234def');
  await expect(page.getByText('1 / 16')).toBeVisible();
  expect(sql(`select count(*) from audit_events where workspace_id='${w.ws}' and action='gate.set'`)).toBe('1');
  // live opt-in
  await page.getByTestId('live-optin-toggle').click();
  const c = page.getByRole('dialog'); await expect(c).toContainText('does not'); await expect(c).toContainText('operator feature flag');
  const go = c.getByRole('button', { name: 'Record opt-in' }); await expect(go).toBeDisabled(); await c.getByLabel('Type ENABLE LIVE to confirm').fill('ENABLE LIVE'); await go.click();
  await expect(page.getByText('Owner opt-in: ON')).toBeVisible(); await expect(page.getByText('Live execution: LOCKED')).toBeVisible();
  await page.reload(); await expect(page.getByText('Owner opt-in: ON')).toBeVisible(); await expect(page.getByText('Live execution: LOCKED')).toBeVisible();
  expect(sql(`select live_opt_in from workspace_settings where workspace_id='${w.ws}'`)).toBe('t');
});

test('risk: emergency workflow E-01..E-04 (bucket scope then global), settlement keeps running, resume', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page); const w = await seedWorld(page);
  await page.goto('/risk'); await page.getByRole('button', { name: 'Emergency controls' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Scope').selectOption('bucket'); await d.getByLabel('Bucket', { exact: true }).selectOption(w.B); await d.getByLabel(/^Reason/).fill('drill: bucket'); await d.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(d).toContainText('stop new entries only'); await d.getByLabel('Exit policy').selectOption('exit'); await d.getByRole('button', { name: 'Next', exact: true }).click();
  const apply = d.getByRole('button', { name: 'Apply now' }); await expect(apply).toBeDisabled(); await d.getByLabel(/^Type EXIT ONLY/).fill('EXIT ONLY'); await apply.dblclick();
  await expect(d.getByTestId('emergency-observe')).toContainText('Transfers still settling'); await expect(d.getByTestId('emergency-observe')).toContainText('No settlement worker');
  await d.getByRole('button', { name: 'Close', exact: true }).last().click();
  expect(sql(`select state from buckets where id='${w.B}'`)).toBe('exit_only'); expect(sql(`select count(*) from emergency_actions where workspace_id='${w.ws}' and scope='BUCKET'`)).toBe('1');
  await page.reload(); await page.getByRole('tab', { name: 'Bucket' }).click();
  const t = page.getByRole('table', { name: 'Bucket risk controls' }); await expect(t).toContainText('exit only'); await t.getByRole('row', { name: /Growth/ }).getByRole('button', { name: 'Resume' }).click();
  await expect(t.getByRole('row', { name: /Growth/ })).toContainText('active');
  // global
  await page.getByRole('button', { name: 'Emergency controls' }).click(); const g = page.getByRole('dialog');
  await g.getByLabel(/^Reason/).fill('drill: global'); await g.getByRole('button', { name: 'Next', exact: true }).click(); await g.getByRole('button', { name: 'Next', exact: true }).click();
  await g.getByLabel(/^Type HALT/).fill('halt'); await g.getByRole('button', { name: 'Apply now' }).click(); await expect(g.getByTestId('emergency-observe')).toContainText('halt new entries'); await g.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('tab', { name: 'Global' }).click(); await expect(page.getByRole('table', { name: 'Current violations' })).toContainText('Global state is halt_new_entries'); await expect(page.getByRole('table', { name: 'Current violations' })).toContainText('workspace_settings.global_state');
  await page.getByRole('button', { name: 'Resume approved' }).click(); await expect(page.getByRole('table', { name: 'Current violations' })).not.toContainText('Global state is');
  await page.reload(); await page.getByRole('tab', { name: 'Incidents' }).click(); await expect(page.getByRole('table', { name: 'Emergency actions' })).toContainText('HALT_NEW_ENTRIES');
});

test('risk: policy wizard R-01..R-04 shows diff and the API 422 verbatim; valid change saves a new version', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page); const w = await seedWorld(page);
  await page.goto('/risk'); await page.getByRole('tab', { name: 'Bucket' }).click(); await page.getByRole('button', { name: 'Edit risk policy of Trading' }).click();
  const d = page.getByRole('dialog'); await expect(d).toContainText('child limit can never exceed the global hard limit'); await d.getByRole('button', { name: 'Next', exact: true }).click();
  await d.getByLabel('Max slippage (bps)').fill('9999'); await expect(d.getByTestId('policy-diff')).toContainText('9999'); await d.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(d).toContainText('exceeds the global hard limit 100'); await d.getByRole('button', { name: 'Next', exact: true }).click();
  const save = d.getByRole('button', { name: /Save policy version 2/ }); await expect(save).toBeDisabled(); await d.getByLabel(/Type the bucket name/).fill('Trading'); await save.click();
  await expect(d.getByTestId('policy-error')).toContainText('bucket max_slippage_bps cannot exceed the global hard limit');
  await d.getByRole('button', { name: 'Back', exact: true }).click(); await d.getByRole('button', { name: 'Back', exact: true }).click(); await d.getByLabel('Max slippage (bps)').fill('40');
  await d.getByRole('button', { name: 'Next', exact: true }).click(); await d.getByRole('button', { name: 'Next', exact: true }).click(); await d.getByLabel(/Type the bucket name/).fill('Trading'); await d.getByRole('button', { name: /Save policy version 2/ }).dblclick();
  await expect(page.getByText('Policy v2 saved')).toBeVisible();
  await page.reload(); await page.getByRole('tab', { name: 'Bucket' }).click(); await expect(page.getByRole('table', { name: 'Bucket risk controls' }).getByRole('row', { name: /Trading/ })).toContainText('"max_slippage_bps":40');
  expect((await get(page, `v1/buckets/${w.A}`)).json.bucket.policy_version).toBe(2);
});

test('risk: exposure tabs are ledger-only and say so', async ({ page }) => {
  await login(page); await seedWorld(page); await page.goto('/risk');
  for (const [tab, cap] of [['Bucket', 'Exposure by bucket'], ['Wallet', 'Exposure by wallet'], ['Chain', 'Exposure by chain'], ['Token', 'Exposure by token']] as const) {
    await page.getByRole('tab', { name: tab }).click(); const t = page.getByRole('table', { name: cap }); await expect(t).toContainText('USDC');
  }
  await page.getByRole('tab', { name: 'Chain' }).click(); await expect(page.getByText('NOT_MEASURED')).toBeVisible();
  await page.getByRole('tab', { name: 'Strategy' }).click(); await page.getByRole('tab', { name: 'Incidents' }).click(); await expect(page.getByText('an empty list is not proof of health')).toBeVisible();
});
