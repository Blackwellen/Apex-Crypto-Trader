import { test } from '@playwright/test';
import { createWorkspaceIfNeeded, login } from './helpers';
test('dbg', async ({ page }) => {
  await login(page); await createWorkspaceIfNeeded(page);
  const id = await page.evaluate(async () => { const w = (await (await fetch('/api/proxy/v1/workspaces')).json()).items[0].id; const r = await (await fetch(`/api/proxy/v1/research/backtests?workspace=${w}`)).json(); return r.items[0]?.id; });
  console.log('id', id);
});
