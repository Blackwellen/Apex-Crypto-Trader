import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import path from 'node:path';

export const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 1024, h: 768 }, { w: 768, h: 1024 }, { w: 390, h: 844 }];
export const SHOTS = path.resolve(__dirname, '../../../docs/evidence/screenshots');

export async function login(page: Page, email = `e2e-${Date.now()}@apex.test`) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL('**/dashboard');
  return email;
}
export async function a11y(page: Page, label: string) {
  await page.waitForTimeout(800); // let enter animations (toasts) finish: axe samples mid-fade colours otherwise
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes) ${v.nodes[0]?.html?.slice(0, 160)}`), `axe violations on ${label}`).toEqual([]);
}
export async function createWorkspaceIfNeeded(page: Page) {
  // wait for the workspace query to settle: either the first-run card or the live controls appear
  const create = page.getByRole('button', { name: 'Create workspace' });
  const ready = page.getByRole('button', { name: /Start paper engine|Stop paper engine|Resume approved/ });
  await expect(create.or(ready).first()).toBeVisible();
  if (await create.isVisible()) { await create.click(); await expect(ready.first()).toBeVisible(); }
}
