import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { login } from './helpers';
import { cmd, seedProfit, seedWorld, sql } from './ops-helpers';

test('treasury: ledger reconciliation, CSV export (BigInt-exact), honest tax/GBP notes, exception add/resolve persists', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page); const w = await seedWorld(page); seedProfit(w, '1');
  await page.goto('/treasury'); await expect(page.getByRole('heading', { name: 'Treasury and Tax' })).toBeVisible();
  const rec = page.getByRole('table', { name: 'Cash-flow reconciliation' }); await expect(rec).toContainText('USDC'); await expect(rec).toContainText('1,600'); await expect(rec).toContainText('reconciled');
  await expect(page.getByText('not tax advice').first()).toBeVisible(); await expect(page.getByText('GBP cost basis and gains require historical FX')).toBeVisible(); await expect(page.getByText('ledger against itself')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Protected vault balances' })).toContainText('500'); await expect(page.getByText('Internal transfers (excluded from performance)')).toBeVisible();
  const dl = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export cashflow-reconciliation.csv' }).click();
  const file = await (await dl).path(); const csv = fs.readFileSync(file!, 'utf8'); expect(csv).toContain('paper,USDC,1600000000,1600000000,0,0,0,0,6');
  // exception
  await page.getByRole('button', { name: 'Add reconciliation exception' }).click(); const d = page.getByRole('dialog');
  await d.getByLabel('Asset').selectOption(w.USDC); await d.getByLabel(/Ledger says/).fill('1000'); await d.getByLabel(/External source says/).fill('999.5'); await d.getByLabel('Source of the external figure').fill('Statement 2026-10-01');
  await d.getByRole('button', { name: 'Record exception' }).dblclick();
  const ex = page.getByRole('table', { name: 'Reconciliation exceptions' }); await expect(ex).toContainText('open'); await expect(ex).toContainText('999.5'); await expect(ex.getByRole('row')).toHaveCount(2);
  await page.reload(); await expect(page.getByRole('table', { name: 'Reconciliation exceptions' })).toContainText('Statement 2026-10-01');
  await page.getByRole('button', { name: 'Resolve', exact: true }).click(); await page.getByRole('dialog').getByLabel(/Resolution note/).fill('Matched after fee correction'); await page.getByRole('button', { name: 'Mark resolved' }).click();
  await expect(page.getByRole('table', { name: 'Reconciliation exceptions' })).toContainText('resolved');
  await page.reload(); await expect(page.getByRole('table', { name: 'Reconciliation exceptions' })).toContainText('Matched after fee correction');
  expect(sql(`select count(*) from reconciliation_discrepancies where workspace_id='${w.ws}'`)).toBe('1');
});

test('operations: pause non-essential never touches essential jobs; dead-letter retry is idempotent; honest worker note', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page); const w = await seedWorld(page);
  const j = (q: string, e: boolean, s = 'queued') => sql(`insert into jobs(workspace_id,queue,essential,status,last_error) values ('${w.ws}','${q}',${e},'${s}',${s === 'dead' ? "'rpc timeout'" : 'null'}) returning id`).split('\n')[0];
  const ess = j('settlement', true), r1 = j('research', false), r2 = j('llm-batch', false, 'running'); const dead = j('token-scan', false, 'dead');
  await page.goto('/operations/jobs'); await expect(page.getByText('no job consumer is deployed').or(page.getByText('no job consumer'))).toBeVisible();
  await expect(page.getByRole('table', { name: 'Jobs by queue, status and class' })).toContainText('essential');
  await page.getByRole('button', { name: 'Pause non-essential research jobs' }).click(); const c = page.getByRole('dialog'); await expect(c).toContainText('Essential safety jobs are not affected');
  const go = c.getByRole('button', { name: 'Pause non-essential' }); await expect(go).toBeDisabled(); await c.getByLabel('Type PAUSE to confirm').fill('PAUSE'); await go.click();
  await expect(page.getByText('Non-essential paused')).toBeVisible();
  expect(sql(`select paused from jobs where id='${ess}'`)).toBe('f'); expect(sql(`select paused from jobs where id='${r1}'`)).toBe('t'); expect(sql(`select paused from jobs where id='${r2}'`)).toBe('t');
  await page.reload(); await expect(page.getByText('Non-essential paused')).toBeVisible();
  const dl = page.getByRole('table', { name: 'Failed and dead-letter jobs' }); await expect(dl).toContainText('rpc timeout');
  await dl.getByRole('button', { name: 'Retry' }).dblclick();
  await expect(page.getByText('No failed or dead-lettered jobs')).toBeVisible();
  expect(sql(`select status from jobs where id='${dead}'`)).toBe('queued'); expect(sql(`select count(*) from job_retries where job_id='${dead}'`)).toBe('1');
  await page.getByRole('button', { name: 'Resume non-essential jobs' }).click(); await expect(page.getByText('Running normally')).toBeVisible();
});

test('audit: filters, pagination, detail drawer, incident record + acknowledge, CSV export; persists', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page); const w = await seedWorld(page);
  for (let i = 0; i < 12; i++) await cmd(page, 'recordIncident', { workspace: w.ws, class: 'drill', severity: 'info', message: `seed incident ${i}` });
  await page.goto('/operations/audit'); await expect(page.getByRole('heading', { name: 'Audit and Incidents' })).toBeVisible();
  const total = page.getByTestId('audit-total'); await expect(total).toContainText('event(s) match'); const n = Number((await total.innerText()).split(' ')[0]); expect(n).toBeGreaterThan(25);
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled(); await page.getByRole('button', { name: 'Next', exact: true }).click(); await expect(total).toContainText('showing 26-');
  await page.getByLabel('Action').selectOption('incident.record'); await expect(total).toContainText('12 event(s) match');
  await page.getByLabel('Entity').selectOption('alerts'); await expect(total).toContainText('12 event(s) match');
  await page.getByLabel('From date').fill('2999-01-01'); await expect(total).toContainText('0 event(s) match'); await page.getByLabel('From date').fill('');
  await page.getByRole('button', { name: /Details of event/ }).first().click(); const d = page.getByRole('dialog'); await expect(d).toContainText('incident.record'); await expect(d).toContainText('"class": "drill"'); await d.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(page.getByText('append-only')).toBeVisible();
  const dl = page.waitForEvent('download'); await page.getByRole('button', { name: /Export CSV/ }).click(); const csv = (await import('node:fs')).readFileSync((await (await dl).path())!, 'utf8'); expect(csv).toContain('incident.record');
  // incidents
  await page.getByRole('button', { name: 'Record incident' }).click(); const r = page.getByRole('dialog'); await r.getByLabel('Class').fill('rpc'); await r.getByLabel('Severity').selectOption('critical'); await r.getByLabel('What happened').fill('Primary RPC down'); await r.getByRole('button', { name: 'Record', exact: true }).dblclick();
  const inc = page.getByRole('table', { name: 'Incidents' }); await expect(inc).toContainText('Primary RPC down');
  expect(sql(`select count(*) from alerts where workspace_id='${w.ws}' and message='Primary RPC down'`)).toBe('1');
  await page.reload(); const row = page.getByRole('table', { name: 'Incidents' }).getByRole('row', { name: /Primary RPC down/ });
  await row.getByLabel(/Note for incident/).fill('provider failed over'); await row.getByRole('button', { name: 'Acknowledge' }).dblclick();
  await expect(page.getByRole('table', { name: 'Incidents' }).getByRole('row', { name: /Primary RPC down/ })).toContainText('acknowledged');
  await page.reload(); await expect(page.getByRole('table', { name: 'Incidents' }).getByRole('row', { name: /Primary RPC down/ })).toContainText('provider failed over');
  expect(sql(`select count(*) from audit_events where workspace_id='${w.ws}' and action='alert.acknowledge'`)).toBe('1');
});

test('settings: members, invite disabled, role matrix, integrations truthfully not configured, limits tighten-only with approval path', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page); const w = await seedWorld(page);
  await page.goto('/settings'); await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Workspace members' })).toContainText('owner'); await expect(page.getByRole('button', { name: 'Invite member' })).toBeDisabled(); await expect(page.getByText('Inviting members requires Supabase Auth')).toBeVisible();
  await expect(page.getByTestId('role-matrix')).toContainText('Sign off deployment gates'); await expect(page.getByText('LOCAL DEV AUTH', { exact: true })).toBeVisible();
  for (const [k, s] of [['supabase_auth', 'NOT CONFIGURED'], ['kms_signer', 'BLOCKED'], ['coinbase', 'NOT CONFIGURED'], ['rpc', 'NOT CONFIGURED'], ['llm', 'NOT CONFIGURED']] as const) { const el = page.getByTestId(`integration-${k}`); await expect(el).toContainText(s); await expect(el.getByRole('listitem').first()).toBeVisible(); }
  await expect(page.getByText('Live execution is LOCKED').last()).toBeVisible(); await expect(page.getByText('No automated retention')).toBeVisible();
  // tighten
  await page.getByLabel(/New max slippage/).fill('50'); await page.getByLabel('Reason (audit log)').fill('tighten for drill');
  await page.getByRole('button', { name: 'Apply tighter limits' }).dblclick();
  await expect(page.getByText('Limits tightened')).toBeVisible();
  await page.reload(); await expect(page.getByRole('table', { name: 'Global hard limits' })).toContainText('50');
  expect(sql(`select global_limits->>'max_slippage_bps' from workspace_settings where workspace_id='${w.ws}'`)).toBe('50');
  // loosening is not a direct action
  await page.getByLabel(/New max slippage/).fill('90'); await page.getByLabel('Reason (audit log)').fill('need headroom');
  await expect(page.getByText('would be loosened')).toBeVisible(); await expect(page.getByRole('button', { name: 'Apply tighter limits' })).toBeDisabled();
  await page.getByRole('button', { name: 'Request an increase' }).dblclick();
  const req = page.getByRole('table', { name: 'Limit increase requests' }); await expect(req).toContainText('pending'); await expect(req.getByRole('row')).toHaveCount(2); await expect(req.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  expect(sql(`select global_limits->>'max_slippage_bps' from workspace_settings where workspace_id='${w.ws}'`)).toBe('50');
  await page.reload(); await expect(page.getByRole('table', { name: 'Limit increase requests' })).toContainText('pending');
});
