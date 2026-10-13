import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { a11y, createWorkspaceIfNeeded, login, SHOTS, VIEWPORTS } from './helpers';

test('unauthenticated users are redirected to /login and API proxy refuses', async ({ page, request }) => {
  await page.goto('/dashboard'); await expect(page).toHaveURL(/\/login$/);
  expect((await request.get('/api/proxy/v1/workspaces')).status()).toBe(401);
});

test('login -> first-run workspace creation -> dashboard shows locked live + paper banner; keyboard skip link; axe clean at 5 viewports', async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await expect(page.getByText('Create your workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByText('Ledger-backed view of segregated capital')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Environment' })).toContainText('LOCKED');
  await expect(page.getByText('Paper mode')).toBeVisible();
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h }); await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/dashboard-${v.w}.png`, fullPage: true });
    await a11y(page, `dashboard@${v.w}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow, `horizontal overflow at ${v.w}px`).toBe(false);
  }
  expect(errors).toEqual([]);
});

test('emergency stop requires typing STOP, halts entries, and disables paper start', async ({ page }) => {
  await login(page); await createWorkspaceIfNeeded(page);
  await page.getByRole('button', { name: 'Start paper engine' }).click();
  await expect(page.getByText('Paper engine running').first()).toBeVisible();
  await page.getByRole('button', { name: 'Emergency stop' }).click();
  const confirm = page.getByRole('button', { name: 'Stop new entries' }); await expect(confirm).toBeDisabled();
  await page.getByLabel('Type STOP to confirm').fill('STOP'); await confirm.click();
  await expect(page.getByText('emergency stopped').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start paper engine' })).toHaveCount(0);
});
