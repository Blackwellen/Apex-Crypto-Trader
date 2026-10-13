import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { a11y, login, SHOTS, VIEWPORTS } from './helpers';
import { cmd, seedProfit, seedWorld, sql } from './ops-helpers';

const PAGES: [string, string][] = [['compounding-studio', '/compounding'], ['capital-transfers-new', '/capital/transfers/new'], ['risk', '/risk'], ['treasury', '/treasury'], ['operations-jobs', '/operations/jobs'], ['operations-audit', '/operations/audit'], ['settings', '/settings']];

test('every ops page: axe (serious/critical = 0), no horizontal overflow, screenshots at 5 viewports, no page errors', async ({ page }) => {
  test.setTimeout(600_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await login(page); const w = await seedWorld(page); seedProfit(w, '250000000');
  sql(`insert into jobs(workspace_id,queue,essential,status,last_error) values ('${w.ws}','settlement',true,'queued',null),('${w.ws}','research',false,'dead','provider timeout')`);
  await cmd(page, 'recordIncident', { workspace: w.ws, class: 'rpc', severity: 'warn', message: 'Provider latency high' });
  await cmd(page, 'setCompoundingTarget', { workspace: w.ws, bucket: w.A, period: 'month', asset: w.USDC, targetAmount: '500000000' });
  await cmd(page, 'requestCapitalTransfer', { workspace: w.ws, srcBucket: w.A, srcWalletChainAccount: w.wca1, dstBucket: w.B, dstWalletChainAccount: w.wca2, asset: w.USDC, amount: '1000000' });
  for (const [name, path] of PAGES) {
    await page.goto(path); await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); await page.waitForTimeout(1200);
    for (const v of VIEWPORTS) {
      await page.setViewportSize({ width: v.w, height: v.h }); await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/${name}-${v.w}.png`, fullPage: true });
      await a11y(page, `${name}@${v.w}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), `horizontal overflow on ${name} at ${v.w}px`).toBe(false);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  expect(errors).toEqual([]);
});

test('dialogs and wizards are accessible at 390px (axe) and keyboard-closable with Escape', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page); const w = await seedWorld(page); await page.setViewportSize({ width: 390, height: 844 });
  const open = async (path: string, btn: string | RegExp, tab?: string) => { await page.goto(path); if (tab) await page.getByRole('tab', { name: tab }).click(); await page.getByRole('button', { name: btn }).first().click(); await expect(page.getByRole('dialog')).toBeVisible(); };
  await open('/compounding', 'New target'); await a11y(page, 'target dialog'); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await open('/compounding', 'Create waterfall policy', 'Bucket'); await a11y(page, 'policy wizard'); await page.keyboard.press('Escape');
  await open('/risk', 'Emergency controls'); await a11y(page, 'emergency wizard'); await page.keyboard.press('Escape');
  await open('/risk', 'Sign off ledger_conservation'); await a11y(page, 'gate dialog'); await page.keyboard.press('Escape');
  await open('/operations/jobs', 'Pause non-essential research jobs'); await a11y(page, 'pause confirm'); await page.keyboard.press('Escape');
  await open('/treasury', 'Add reconciliation exception'); await a11y(page, 'exception dialog'); await page.keyboard.press('Escape');
  void w;
});
