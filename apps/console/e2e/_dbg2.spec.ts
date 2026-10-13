import { test } from '@playwright/test';
test('dbg2', async ({ page }) => {
  test.setTimeout(120000);
  const { login, createWorkspaceIfNeeded } = await import('./helpers');
  await login(page); await createWorkspaceIfNeeded(page);
  await page.goto('/research'); await page.getByRole('tab', { name: 'New backtest' }).click();
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Bootstrap resamples (metric intervals)'); 
  await page.getByRole('button', { name: 'Run backtest' }).click();
  await page.waitForURL(/research\/[0-9a-f-]{36}/, { timeout: 90000 });
  await page.setViewportSize({ width: 768, height: 1024 }); await page.waitForTimeout(500);
  const bad = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map((e) => e.tagName + '.' + String(e.className).slice(0, 80) + ' ' + Math.round(e.getBoundingClientRect().right) + ' ' + (e.textContent || '').slice(0, 40)));
  console.log(JSON.stringify(bad, null, 1));
});
