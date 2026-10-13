import { expect, test } from '@playwright/test';
import { login } from './helpers';
import { get, seedProfit, seedWorld, type World } from './ops-helpers';

test('compounding: target progress from ledger, waterfall wizard enforces 100%, formula preview, double-click saves ONE version, persistence after reload', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page); const w: World = await seedWorld(page); seedProfit(w, '250000000');   // +250 USDC realised, reconciled
  await page.goto('/compounding'); await expect(page.getByRole('heading', { name: 'Compounding Studio' })).toBeVisible();
  // ---- target (monitoring only), progress from the ledger
  await page.getByRole('button', { name: 'New target' }).click();
  const dlg = page.getByRole('dialog'); await expect(dlg).toContainText('monitoring only');
  await dlg.getByLabel('Scope').selectOption({ label: 'Trading' }); await dlg.getByLabel('Reporting asset').selectOption(w.USDC);
  await dlg.getByLabel('Absolute target (USDC)').fill('500');
  await dlg.getByRole('button', { name: 'Save target' }).dblclick();
  const row = page.getByTestId('target-row'); await expect(row).toHaveCount(1); await expect(row).toContainText('Trading · month'); await expect(row).toContainText('250 of 500 USDC'); await expect(row).toContainText('50.00% of target');
  await page.reload(); await expect(page.getByTestId('target-row')).toHaveCount(1); await expect(page.getByTestId('target-row')).toContainText('50.00% of target');
  // ---- waterfall wizard
  await page.getByRole('tab', { name: 'Bucket' }).click();
  await page.getByRole('button', { name: 'Create waterfall policy' }).click();
  const wiz = page.getByRole('dialog'); await expect(wiz).toContainText('immutable versions');
  await wiz.getByLabel(/Reporting asset/).selectOption(w.USDC); await wiz.getByRole('button', { name: 'Next', exact: true }).click();
  await wiz.getByTestId('wf-reinvest').fill('40'); await wiz.getByTestId('wf-vault').fill('35'); await wiz.getByTestId('wf-cross').fill('0'); await wiz.getByTestId('wf-reserve').fill('10'); await wiz.getByTestId('wf-tax').fill('10');
  await expect(wiz.getByTestId('wf-total')).toContainText('85.00%'); await expect(wiz.getByTestId('wf-total')).toContainText('must be exactly 100.00%');
  await expect(wiz.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await wiz.getByTestId('wf-reserve').fill('25'); await expect(wiz.getByTestId('wf-total')).toContainText('exactly 100%'); await expect(wiz.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await wiz.getByRole('button', { name: 'Next', exact: true }).click(); await expect(wiz).toContainText('RECONCILED'); await wiz.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(wiz.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();   // vault portion needs a destination
  await wiz.getByLabel('Vault bucket').selectOption({ label: 'Vault' }); await wiz.getByLabel('Vault wallet / chain account').selectOption({ label: 'W3 on Ethereum' });
  await expect(wiz).toContainText('PHYSICAL transfer'); await wiz.getByRole('button', { name: 'Next', exact: true }).click();
  await wiz.getByLabel(/Sample realised profit/).fill('100');
  const prev = wiz.getByTestId('wf-preview');   // tax 10, vault floor(90*35%)=31.5, reserve 22.5, reinvest remainder 36
  await expect(prev).toContainText('Tax provision (restricted)10 USDC'); await expect(prev).toContainText('Protected vault31.5 USDC'); await expect(prev).toContainText('Fee / gas reserve22.5 USDC'); await expect(prev).toContainText('Reinvest (incl. rounding remainder)36 USDC');
  await wiz.getByLabel(/Sample realised profit/).fill('0.000007');   // rounding: eligible 7 units, tax 0, vault floor(7*0.35)=2, reserve floor(7*.25)=1, reinvest 4
  await expect(prev).toContainText('Protected vault0.000002 USDC'); await expect(prev).toContainText('Reinvest (incl. rounding remainder)0.000004 USDC');
  await wiz.getByRole('button', { name: 'Save as version 1' }).dblclick();   // mashed twice
  await expect(page.getByText('Compounding policy v1 saved')).toBeVisible();
  await page.reload(); await page.getByRole('tab', { name: 'Global' }).click();
  await expect(page.getByRole('table', { name: 'Compounding policy versions' }).getByRole('row')).toHaveCount(2);   // header + exactly ONE version
  const c = await get(page, `v1/compounding?workspace=${w.ws}`); expect(c.json.policies).toHaveLength(1); expect(c.json.policies[0]).toMatchObject({ reinvest_bps: 4000, vault_bps: 3500, reserve_bps: 2500, tax_provision_bps: 1000 });
  // ---- immutable versions + simulator labelling
  await page.getByRole('tab', { name: 'Bucket' }).click(); await expect(page.getByText('Illustrative arithmetic, not a forecast')).toBeVisible();
  await page.getByRole('button', { name: 'Edit waterfall (new version)' }).click(); await expect(page.getByRole('dialog')).toContainText('version 2');
});
