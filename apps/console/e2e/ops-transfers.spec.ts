import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';
import { addSecondOwner, get, seedWorld, sql, type World } from './ops-helpers';

async function pickRoute(page: Page, w: World, src: [string, string], dst: [string, string], amount: string) {
  await page.getByLabel('Source bucket').selectOption(src[0]); await page.getByLabel('Source wallet / chain account').selectOption({ label: src[1] }); await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Destination bucket').selectOption(dst[0]); await page.getByLabel('Destination wallet / chain account').selectOption({ label: dst[1] }); await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Asset (from the source account\'s available balance)').selectOption(w.USDC); await page.getByLabel(/^Amount/).fill(amount);
}

test('transfer wizard: PHYSICAL stays pending (destination not credited), paper finality confirms; double-click = ONE transfer; persists after reload', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page); const w = await seedWorld(page);
  await page.goto('/capital/transfers/new'); await expect(page.getByRole('heading', { name: 'Capital transfers' })).toBeVisible();
  await pickRoute(page, w, [w.A, 'W1 on Ethereum'], [w.B, 'W2 on Ethereum'], '25.5');
  await expect(page.getByText('Available: 1,000 USDC')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const prev = page.getByTestId('transfer-preview');
  await expect(prev).toContainText('PHYSICAL'); await expect(prev).toContainText('pending_finality'); await expect(prev).toContainText('NOT credited'); await expect(prev).toContainText('974.5 USDC'); await expect(prev).toContainText('Not estimated');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Submit transfer' }).dblclick();             // mashed twice
  const tr = page.getByTestId('transfer-tracking'); await expect(tr).toContainText('pending finality');
  expect((await get(page, `v1/allocations?workspace=${w.ws}`)).json.transfers).toHaveLength(1);
  expect(sql(`select coalesce(sum(balance),0) from ledger_accounts where bucket_id='${w.B}' and state='available'`)).toBe('0');   // destination NOT credited
  expect(sql(`select coalesce(sum(balance),0) from ledger_accounts where bucket_id='${w.A}' and state='pending_out'`)).toBe('25500000');
  await page.reload(); await page.getByRole('tab', { name: 'Tracking' }).click();
  const tbl = page.getByRole('table', { name: 'Capital transfers' }); await expect(tbl).toContainText('pending finality'); await expect(tbl).toContainText('25.5 USDC'); await expect(tbl.getByRole('row')).toHaveCount(2);
  await tbl.getByRole('button', { name: 'Confirm', exact: true }).dblclick();
  await expect(tbl).toContainText('confirmed');
  await page.reload(); await page.getByRole('tab', { name: 'Tracking' }).click(); await expect(page.getByRole('table', { name: 'Capital transfers' })).toContainText('confirmed');
  expect(sql(`select coalesce(sum(balance),0) from ledger_accounts where bucket_id='${w.B}' and state='available'`)).toBe('25500000');
});

test('transfer wizard: failed paper transfer returns funds; LOGICAL same-wallet transfer is instant and atomic; vault is refused', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page); const w = await seedWorld(page);
  await page.goto('/capital/transfers/new');
  await pickRoute(page, w, [w.L1, 'W4 on Ethereum'], [w.L2, 'W4 on Ethereum'], '40'); await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByTestId('transfer-preview')).toContainText('LOGICAL'); await expect(page.getByTestId('transfer-preview')).toContainText('atomic'); await expect(page.getByTestId('transfer-preview')).toContainText('confirmed');
  await page.getByRole('button', { name: 'Next', exact: true }).click(); await page.getByRole('button', { name: 'Submit transfer' }).click();
  await expect(page.getByTestId('transfer-tracking')).toContainText('confirmed'); expect(sql(`select coalesce(sum(balance),0) from ledger_accounts where bucket_id='${w.L2}' and state='available'`)).toBe('40000000');
  await page.getByRole('button', { name: 'Start another transfer' }).click();
  await pickRoute(page, w, [w.A, 'W1 on Ethereum'], [w.B, 'W2 on Ethereum'], '10'); await page.getByRole('button', { name: 'Next', exact: true }).click(); await page.getByRole('button', { name: 'Next', exact: true }).click(); await page.getByRole('button', { name: 'Submit transfer' }).click();
  await page.getByRole('button', { name: 'Simulate failure' }).click(); await expect(page.getByTestId('transfer-tracking')).toContainText('Failed');
  expect(sql(`select balance from ledger_accounts where bucket_id='${w.A}' and state='available' and asset_id='${w.USDC}'`)).toBe('1000000000');
  await page.getByRole('button', { name: 'Start another transfer' }).click();
  await page.getByLabel('Source bucket').selectOption(w.V); await page.getByLabel('Source wallet / chain account').selectOption({ label: 'W3 on Ethereum' });
  await expect(page.getByText('Protected vault funds are never moved by an ordinary transfer')).toBeVisible(); await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
});

test('vault release: request, four-eyes blocks self-approval, delay shown, execute after approval + delay; persists', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page); const w = await seedWorld(page);
  await page.goto('/capital/transfers/new'); await page.getByRole('tab', { name: 'Protected vault release' }).click();
  await expect(page.getByText('different owner')).toBeVisible();
  await page.getByLabel('Vault bucket').selectOption(w.V); await page.getByLabel('Wallet / chain account').selectOption({ label: 'W3 on Ethereum' }); await page.getByLabel(/^Asset/).selectOption(w.USDC); await page.getByLabel(/^Amount/).fill('600');
  await expect(page.getByText('Exceeds the vault balance')).toBeVisible(); await page.getByLabel(/^Amount/).fill('200');
  await page.getByRole('button', { name: 'Request release' }).dblclick();
  const t = page.getByRole('table', { name: 'Vault release requests' }); await expect(t).toContainText('pending'); await expect(t).toContainText('you'); await expect(t.getByRole('row')).toHaveCount(2);
  await expect(t.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled(); await expect(t).toContainText('remaining');
  await page.reload(); await page.getByRole('tab', { name: 'Protected vault release' }).click(); await expect(page.getByRole('table', { name: 'Vault release requests' })).toContainText('pending');
  // a SECOND owner approves (done at the DB: invites need Supabase); delay is then waived for the test
  const o2 = addSecondOwner(w.ws); sql(`update approval_requests set status='approved', approved_by='${o2}', decided_at=now() where workspace_id='${w.ws}'`);
  await page.reload(); await page.getByRole('tab', { name: 'Protected vault release' }).click();
  const t2 = page.getByRole('table', { name: 'Vault release requests' }); await expect(t2.getByRole('button', { name: 'Execute release' })).toBeDisabled();   // delay not elapsed
  sql(`update approval_requests set not_before=now()-interval '1 minute' where workspace_id='${w.ws}'`);
  await page.reload(); await page.getByRole('tab', { name: 'Protected vault release' }).click();
  await page.getByRole('table', { name: 'Vault release requests' }).getByRole('button', { name: 'Execute release' }).dblclick();
  await expect(page.getByRole('table', { name: 'Vault release requests' })).toContainText('executed');
  expect(sql(`select balance from ledger_accounts where bucket_id='${w.V}' and state='vault'`)).toBe('300000000');
  expect(sql(`select count(*) from ledger_entries where workspace_id='${w.ws}' and kind='vault_release'`)).toBe('1');
});
