import { execFileSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { a11y, SHOTS, VIEWPORTS } from './helpers';

export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
/** Reference data (chains + canonical assets) is global and not writable by end users; seed it as the DB owner, idempotently. */
export function seedReferenceData() {
  const sql = `
    insert into chain_registry(id,namespace,chain_ref,family,name,native_symbol,native_decimals,finality_model,address_format,explorer_url) values
      ('eip155:1','eip155','1','evm','Ethereum','ETH',18,'probabilistic','0x-hex20','https://etherscan.io'),
      ('solana:mainnet','solana','mainnet','svm','Solana','SOL',9,'confirmed','base58','https://explorer.solana.com'),
      ('coinbase:spot','coinbase','spot','cex','Coinbase Exchange','USD',2,'n/a','n/a',null) on conflict (id) do nothing;
    insert into assets(chain_id,contract,symbol,decimals) values ('eip155:1','native','ETH',18),('eip155:1','${USDC}','USDC',6),('coinbase:spot','BTC-USD','BTC',8) on conflict (chain_id,contract) do nothing;`;
  execFileSync('psql', [process.env.E2E_ADMIN_DB ?? 'postgres://postgres@localhost:54329/apex', '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { stdio: 'pipe' });
}
export async function noOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow, `horizontal overflow on ${label}`).toBe(false);
}
/** Screenshots + axe (serious/critical) + overflow at the 5 required viewports. */
export async function sweep(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  // transient toasts fade in/out and make contrast checks flaky: let them leave first
  await expect(page.locator('div[aria-live="polite"][role="status"] > div')).toHaveCount(0, { timeout: 10_000 });
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h }); await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${v.w}.png`, fullPage: true });
    await a11y(page, `${name}@${v.w}`); await noOverflow(page, `${name}@${v.w}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
