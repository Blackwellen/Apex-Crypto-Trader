import { execFileSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { a11y, SHOTS, VIEWPORTS } from './helpers';

/** psql to the dev `apex` DB as postgres (same approach as the test helper). Returns trimmed stdout. */
export function psql(sql: string): string {
  return execFileSync('psql', ['-h', process.env.PGHOST ?? 'localhost', '-p', process.env.PGPORT ?? '54329', '-U', 'postgres', 'apex', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { encoding: 'utf8' }).trim();
}

/** Registry + assets the flows need. Idempotent, so it coexists with seeds from other work. */
export function seedRegistry() {
  psql(`insert into chain_registry(id,namespace,chain_ref,family,name,is_testnet,native_symbol,native_decimals,finality_model,address_format,enabled) values
    ('eip155:1','eip155','1','evm','Ethereum',false,'ETH',18,'probabilistic','0x-hex20',true),
    ('eip155:8453','eip155','8453','evm','Base',false,'ETH',18,'probabilistic','0x-hex20',true),
    ('solana:mainnet','solana','mainnet','svm','Solana',false,'SOL',9,'confirmed','base58-32',true) on conflict (id) do nothing;
    insert into assets(chain_id,contract,symbol,decimals) values
    ('eip155:1','native','ETH',18),('eip155:1','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','USDC',6),('eip155:1','0x6b175474e89094c44da98b954eedeac495271d0f','DAI',18),
    ('eip155:8453','native','ETH',18),('eip155:8453','0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','USDC',6) on conflict (chain_id,contract) do nothing;`);
}

export const EVM_A = '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362';
export const SEED12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const evmAddr = () => '0x' + [...Array(40)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

/** Axe + overflow check + full-page screenshot at the five viewports. */
export async function sweep(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h }); await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${v.w}.png`, fullPage: true });
    await a11y(page, `${name}@${v.w}`);
    const offenders = await page.evaluate(() => {
      const w = window.innerWidth; if (document.documentElement.scrollWidth <= w + 1) return [];
      const clipped = (e: Element) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true; } return false; };
      return [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > w + 1 && !clipped(e)).slice(0, 5).map((e) => `${e.tagName}.${String(e.className).slice(0, 60)}@${Math.round(e.getBoundingClientRect().right)}`);
    });
    expect(offenders, `horizontal overflow on ${name} at ${v.w}px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** Authenticated same-origin API call through the BFF proxy (what the browser itself does). */
export async function apiCmd(page: Page, name: string, body: unknown, key = crypto.randomUUID()) {
  const base = new URL(page.url()).origin;
  return page.request.post(`/api/proxy/v1/commands/${name}`, { data: body as object, headers: { 'x-apex-csrf': '1', origin: base, 'idempotency-key': key, 'content-type': 'application/json' } });
}
export async function apiGet<T = any>(page: Page, path: string): Promise<T> { const r = await page.request.get(`/api/proxy/${path}`); expect(r.ok(), `${path} -> ${r.status()}`).toBeTruthy(); return r.json(); }
