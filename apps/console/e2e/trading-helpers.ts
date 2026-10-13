import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { a11y, SHOTS, VIEWPORTS } from './helpers';

/** psql against the dev `apex` DB as postgres (test fixtures only: chain/asset seed, second member, forced engine states). */
export function sql(q: string): string {
  return execFileSync('psql', ['-h', process.env.PGHOST ?? 'localhost', '-p', process.env.PGPORT ?? '54329', '-U', 'postgres', 'apex', '-v', 'ON_ERROR_STOP=1', '-At', '-c', q], { encoding: 'utf8' }).trim();
}
export const API = process.env.APEX_API_URL ?? 'http://127.0.0.1:4000';
export const evmAddr = () => '0x' + [...Array(40)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

export async function apiCmd(page: Page, name: string, body: unknown, key: string = crypto.randomUUID()) {
  const base = new URL(page.url()).origin;
  return page.request.post(`/api/proxy/v1/commands/${name}`, { data: body as object, headers: { 'x-apex-csrf': '1', origin: base, 'idempotency-key': key, 'content-type': 'application/json' } });
}
export async function apiGet<T = any>(page: Page, path: string): Promise<T> { const r = await page.request.get(`/api/proxy/${path}`); expect(r.ok(), `${path} -> ${r.status()}`).toBeTruthy(); return r.json(); }
const must = async (r: Awaited<ReturnType<typeof apiCmd>>) => { const j = await r.json(); expect(r.ok(), JSON.stringify(j)).toBeTruthy(); return j.result; };

/** Registry/assets the flows need (idempotent; coexists with the real seeds). */
export function ensureAssets() {
  sql(`insert into assets(chain_id,contract,symbol,decimals) select 'eip155:1','native','ETH',18 where exists (select 1 from chain_registry where id='eip155:1') on conflict (chain_id,contract) do nothing;
       insert into assets(chain_id,contract,symbol,decimals) select 'eip155:1','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','USDC',6 where exists (select 1 from chain_registry where id='eip155:1') on conflict (chain_id,contract) do nothing;`);
}

/** Workspace with a funded paper trading bucket: wallet on eip155:1 allocated to the bucket, 1000 USDC deposited + allocated. Page must already be on an app page. */
export async function world(page: Page, usdc = '1000000000') {
  ensureAssets();
  const ws = (await apiGet(page, 'v1/workspaces')).items[0].id as string;
  const assets = (await apiGet(page, 'v1/assets')).items as { id: string; chain_id: string; symbol: string; contract: string }[];
  const eth = assets.find((a) => a.chain_id === 'eip155:1' && a.symbol === 'ETH')!.id; const usdcId = assets.find((a) => a.chain_id === 'eip155:1' && a.symbol === 'USDC' && a.contract === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')!.id;
  const portfolio = (await must(await apiCmd(page, 'createPortfolio', { workspace: ws, name: 'Core' }))).id;
  const bucket = (await must(await apiCmd(page, 'createBucket', { portfolio, name: 'Trading' }))).id;
  const wallet = (await must(await apiCmd(page, 'connectWallet', { workspace: ws, nickname: 'Desk', family: 'evm', address: evmAddr(), chains: ['eip155:1'] }))).id;
  await must(await apiCmd(page, 'assignWalletToBucket', { wallet, bucket }));
  const wca = (await apiGet(page, `v1/wallets/accounts?workspace=${ws}`)).accounts.find((a: any) => a.wallet_id === wallet).id as string;
  await must(await apiCmd(page, 'paperDeposit', { workspace: ws, walletChainAccount: wca, asset: usdcId, amount: usdc }));
  await must(await apiCmd(page, 'allocate', { workspace: ws, bucket, walletChainAccount: wca, asset: usdcId, amount: usdc }));
  return { ws, portfolio, bucket, wallet, wca, eth, usdc: usdcId };
}

/** A second OWNER in the workspace (four-eyes approvals). Uses the dev session endpoint + a membership row. */
export async function secondOwner(request: APIRequestContext, ws: string) {
  const r = await request.post(`${API}/v1/dev/session`, { data: { email: `owner2-${Date.now()}-${Math.floor(Math.random() * 1e6)}@apex.test` } });
  const { userId, token } = await r.json();
  sql(`insert into memberships(workspace_id,user_id,role) values ('${ws}','${userId}','owner')`);
  return { userId, token, cmd: async (name: string, body: unknown) => (await request.post(`${API}/v1/commands/${name}`, { data: body as object, headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() } })) };
}

export async function sweep(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForFunction(() => !document.querySelector('[aria-live=polite][role=status]')?.children.length, null, { timeout: 10_000 }).catch(() => undefined);   // let toasts finish (mid-fade colours are not a real contrast defect)
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h }); await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${v.w}.png`, fullPage: true });
    await a11y(page, `${name}@${v.w}`);
    const offenders = await page.evaluate(() => { const w = window.innerWidth; return document.documentElement.scrollWidth > w + 1 ? [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > w + 1).slice(0, 5).map((e) => `${e.tagName}.${String(e.className).slice(0, 50)}@${Math.round(e.getBoundingClientRect().right)}`) : []; });
    expect(offenders, `horizontal overflow on ${name} at ${v.w}px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
