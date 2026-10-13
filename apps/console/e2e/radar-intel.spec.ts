import { expect, test, type Page } from '@playwright/test';
import { createWorkspaceIfNeeded, login } from './helpers';
import { seedReferenceData, sweep } from './markets-helpers';

test.beforeAll(() => seedReferenceData());
const local = (msAgo: number) => { const d = new Date(Date.now() - msAgo); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

async function logObs(page: Page, o: { contract: string; symbol: string; stage: string; msAgo: number }) {
  await page.getByRole('button', { name: 'Log observation' }).first().click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Chain').selectOption('solana:mainnet');
  await d.getByLabel('Contract / mint address').fill(o.contract); await d.getByLabel('Symbol').fill(o.symbol);
  await d.getByLabel('Stage observed').selectOption(o.stage); await d.getByLabel('Observed at').fill(local(o.msAgo));
  await d.getByLabel('Source').fill('launchpad UI (manual)');
  await d.getByRole('button', { name: 'Record observation' }).click(); await expect(d).toBeHidden();
}

test('meme radar: lifecycle model is a persisted data model; no auto-buy; no fabricated signals; axe x5', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await login(page); await createWorkspaceIfNeeded(page); await page.goto('/meme-radar');
  await expect(page.getByText('No auto-buy.').first()).toBeVisible(); await expect(page.getByText('No tokens tracked yet')).toBeVisible();
  const mint = `E2eMint${Date.now()}`;
  await logObs(page, { contract: mint, symbol: 'E2EMEME', stage: 'bonding_curve', msAgo: 3_600_000 });
  await expect(page.getByRole('link', { name: 'E2EMEME' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Bonding curve 1/ })).toBeVisible();
  await page.reload(); await expect(page.getByRole('link', { name: 'E2EMEME' })).toBeVisible();      // persisted
  await logObs(page, { contract: mint, symbol: 'E2EMEME', stage: 'migrated', msAgo: 600_000 });
  await expect(page.getByRole('button', { name: /Migrated 1/ })).toBeVisible(); await expect(page.getByRole('button', { name: /Bonding curve 0/ })).toBeVisible();
  await logObs(page, { contract: mint, symbol: 'E2EMEME', stage: 'launchpad', msAgo: 7_200_000 });          // late observation must not rewind
  await page.reload(); await expect(page.getByRole('button', { name: /Migrated 1/ })).toBeVisible();
  // watchlist star persists
  await page.getByRole('button', { name: 'Add E2EMEME to watchlist' }).click(); await expect(page.getByRole('button', { name: 'Remove E2EMEME from watchlist' })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: 'Remove E2EMEME from watchlist' })).toBeVisible();
  await page.getByRole('tab', { name: 'Watchlist' }).click(); await expect(page.getByRole('link', { name: 'E2EMEME' })).toBeVisible();
  await page.getByRole('tab', { name: 'Strategy eligibility' }).click(); await expect(page.getByText('No auto-buy; every entry passes the universal security gate + strategy admission + risk gate.')).toBeVisible();
  await page.getByRole('tab', { name: 'Signals not available' }).click(); await expect(page.getByText('Graduation countdown')).toBeVisible(); await expect(page.getByText(/never estimated|no countdown rather than an invented one/).first()).toBeVisible();
  // token page shows the history, newest first, with the late one retained
  await page.goto(`/markets/${encodeURIComponent('solana:mainnet')}/${mint}`);
  await expect(page.getByRole('heading', { name: 'E2EMEME' })).toBeVisible(); await expect(page.getByText('Not in registry')).toBeVisible(); await expect(page.getByText('Launchpad').first()).toBeVisible();
  await page.goto('/meme-radar'); await page.getByRole('tab', { name: 'Tracked tokens' }).click();
  await sweep(page, 'meme-radar');
  expect(errors).toEqual([]);
});

test('intelligence: model disabled status from researcher, manual news is unverified, verification checklist gates catalyst links, persists; axe x5', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page); await createWorkspaceIfNeeded(page);
  await page.goto('/meme-radar'); const mint = `NewsMint${Date.now()}`; await logObs(page, { contract: mint, symbol: 'NEWSY', stage: 'launchpad', msAgo: 1_800_000 });
  await page.goto('/intelligence');
  await expect(page.getByText('Researcher reachable')).toBeVisible();
  await expect(page.getByText('Not configured: Disabled')).toBeVisible(); await expect(page.getByText('Not reported', { exact: true })).toBeVisible();
  await expect(page.getByText('AI-disabled fallback').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Model job queue' }).click(); await expect(page.getByText('No model jobs', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Human approvals' }).click(); await expect(page.getByText('Nothing awaiting approval', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'News & verification' }).click();
  await expect(page.getByText('No news items entered', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add item' }).first().click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Headline / claim').fill('NEWSY listed by a launchpad (claimed)'); await d.getByLabel('Kind').selectOption('social_post');
  await d.getByLabel('Source name').fill('x.com/someone'); await d.getByLabel('Source URL').fill('https://x.com/someone/status/1'); await d.getByLabel(/Original publication time/).fill(local(900_000));
  await d.getByRole('button', { name: 'Add as unverified' }).click();
  const row = page.getByRole('row').filter({ hasText: 'NEWSY listed' });
  await expect(row.getByText('Unverified: not a signal')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Link as catalyst' })).toBeDisabled();
  await page.reload(); await page.getByRole('tab', { name: 'News & verification' }).click(); await expect(row.getByText('Unverified: not a signal')).toBeVisible();   // persisted

  await row.getByRole('button', { name: 'Verify' }).click();
  const v = page.getByRole('dialog'); const mark = v.getByRole('button', { name: 'Mark verified' }); await expect(mark).toBeDisabled();
  const boxes = v.getByRole('checkbox'); for (let i = 0; i < 3; i++) await boxes.nth(i).check();
  await v.getByLabel(/How did you verify it/).fill('Cross-checked on launchpad page'); await expect(mark).toBeDisabled();   // 3 of 4 is not enough
  await boxes.nth(3).check(); await expect(mark).toBeEnabled(); await mark.click();
  await expect(row.getByText('Verified', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Link as catalyst' }).click();
  const l = page.getByRole('dialog'); await l.getByLabel('Tracked token').selectOption({ index: 1 }); await l.getByRole('button', { name: 'Link' }).click();
  await page.reload(); await page.getByRole('tab', { name: 'News & verification' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'NEWSY listed' }).getByText('NEWSY').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Model & fallback' }).click();
  await sweep(page, 'intelligence');
  await page.getByRole('tab', { name: 'News & verification' }).click();
  await sweep(page, 'intelligence-news');
});
