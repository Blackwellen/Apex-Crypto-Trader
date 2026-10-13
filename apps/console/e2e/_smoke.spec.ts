import { test } from '@playwright/test';
import { login } from './helpers';
import { seedWorld } from './ops-helpers';
test('smoke all pages render', async ({ page }) => {
  test.setTimeout(240_000);
  const errs: string[] = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await login(page); const w = await seedWorld(page);
  for (const p of ['/compounding', '/capital/transfers/new', '/risk', '/treasury', '/operations/jobs', '/operations/audit', '/settings']) {
    await page.goto(p); await page.waitForTimeout(2500);
    await page.screenshot({ path: `/tmp/claude-0/smoke${p.replace(/\//g, '_')}.png`, fullPage: true });
  }
  console.log('ERRS', JSON.stringify(errs.slice(0, 20)), JSON.stringify(w));
});
