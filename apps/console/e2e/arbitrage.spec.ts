import { expect, test } from '@playwright/test';
import { createWorkspaceIfNeeded, login } from './helpers';
import { sweep } from './trading-helpers';

test.describe('arbitrage (APEX-018)', () => {
  test('scanner is empty with setup steps; calculator is labelled, exact, separates spread from net edge, and rejects bad input', async ({ page }) => {
    await login(page); await createWorkspaceIfNeeded(page); await page.goto('/arbitrage');
    await expect(page.getByRole('heading', { name: /Arbitrage/, level: 1 })).toBeVisible();
    await expect(page.getByText('No market data feeds connected: the scanner is empty')).toBeVisible();
    await expect(page.getByText('Experimental opportunities never bypass the risk gate.')).toBeVisible();
    await expect(page.getByText('Calculator, not a scanner.')).toBeVisible();
    // defaults: buy 100, sell 100.8, qty 1 -> naive 0.8; costs: fees 0.10+0.1008, slip 0.05+0.0504, latency 0.20, fixed 0.50 => net -0.2012? verify by arithmetic below
    const res = page.locator('div[aria-live=polite]').filter({ hasText: 'Naive spread' });
    await expect(res).toContainText('Executable net edge'); await expect(res).toContainText('Naive spread'); await expect(res).toContainText('0.8'); await expect(res).toContainText('-0.2012');
    await expect(page.locator('p[role=status]')).toContainText(/Negative executable edge|Positive on these inputs/);
    await page.getByLabel('Sell price (bid, quote per base)').fill('101.5'); await page.getByLabel('Fixed costs (quote)').fill('0');
    await expect(page.locator('p[role=status]').filter({ hasText: 'Positive' })).toBeVisible();
    await expect(page.getByRole('row', { name: /Buy cost/ })).toContainText('100');
    await page.getByLabel('Sell price (bid, quote per base)').fill('100.1'); await expect(page.locator('p[role=status]').filter({ hasText: 'Negative' })).toBeVisible();
    await page.getByLabel('Quantity (base units, whole)').fill('-1'); await expect(page.getByText('Enter a positive number')).toBeVisible();
    await page.getByLabel('Quantity (base units, whole)').fill('1'); await page.getByLabel('Buy-leg fee (bps)').fill('1.5'); await expect(page.getByText(/Whole basis points/)).toBeVisible();
    await page.getByLabel('Buy-leg fee (bps)').fill('10');
    await sweep(page, 'arbitrage');
  });
});
