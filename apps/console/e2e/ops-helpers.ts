import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

export const DB_ADMIN = process.env.E2E_ADMIN_DB ?? 'postgres://postgres@localhost:54329/apex';
/** Privileged SQL for test seeding only (what a settlement/worker service would do): the pages under test read it back through the real API. */
export const sql = (q: string): string => execFileSync('psql', [DB_ADMIN, '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim();

const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
export async function cmd(page: Page, name: string, body: object, key = randomUUID()) {
  const r = await page.request.post(`/api/proxy/v1/commands/${name}`, { data: body, headers: { 'x-apex-csrf': '1', origin: ORIGIN, 'idempotency-key': key, 'content-type': 'application/json' } });
  return { status: r.status(), json: await r.json().catch(() => ({})) };
}
export async function get(page: Page, path: string) { const r = await page.request.get(`/api/proxy/${path}`); return { status: r.status(), json: await r.json().catch(() => ({})) }; }
export async function ok(page: Page, name: string, body: object) { const r = await cmd(page, name, body); expect(r.status, `${name}: ${JSON.stringify(r.json)}`).toBe(200); return r.json.result; }

export interface World { ws: string; pf: string; A: string; B: string; V: string; L1: string; L2: string; W1: string; W2: string; W3: string; W4: string; wca1: string; wca2: string; wca3: string; wca4: string; USDC: string; ETH: string; ownerId: string }
/** Fresh workspace with: Trading(A) + Growth(B) physical buckets, protected Vault(V), exclusive wallets W1->A, W2->B, W3->V, and a SHARED wallet W4 in logical buckets L1 and L2. USDC: 1000 in A via W1, 100 in L1 via W4, 500 in V via W3. */
export async function seedWorld(page: Page): Promise<World> {
  const w: any = {};
  w.ws = (await ok(page, 'createWorkspace', { name: 'E2E ' + Date.now() })).id;
  w.pf = (await ok(page, 'createPortfolio', { workspace: w.ws, name: 'Core' })).id;
  w.A = (await ok(page, 'createBucket', { portfolio: w.pf, name: 'Trading' })).id;
  w.B = (await ok(page, 'createBucket', { portfolio: w.pf, name: 'Growth' })).id;
  w.V = (await ok(page, 'createBucket', { portfolio: w.pf, name: 'Vault', kind: 'protected_vault' })).id;
  w.L1 = (await ok(page, 'createBucket', { portfolio: w.pf, name: 'Logical One', segregation: 'logical' })).id;
  w.L2 = (await ok(page, 'createBucket', { portfolio: w.pf, name: 'Logical Two', segregation: 'logical' })).id;
  const mk = async (n: string, addr: string) => (await ok(page, 'connectWallet', { workspace: w.ws, nickname: n, family: 'evm', address: addr, chains: ['eip155:1'] })).id;
  w.W1 = await mk('W1', '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362'); w.W2 = await mk('W2', '0x44f9830d8f779C62ba1C3B98ecbB17C260A69aC4');
  w.W3 = await mk('W3', '0x5555555555555555555555555555555555555555'); w.W4 = await mk('W4', '0x6666666666666666666666666666666666666666');
  await ok(page, 'assignWalletToBucket', { wallet: w.W1, bucket: w.A }); await ok(page, 'assignWalletToBucket', { wallet: w.W2, bucket: w.B }); await ok(page, 'assignWalletToBucket', { wallet: w.W3, bucket: w.V });
  await ok(page, 'assignWalletToBucket', { wallet: w.W4, bucket: w.L1, exclusive: false, maxAllocationBps: 5000, logicalAck: true });
  await ok(page, 'assignWalletToBucket', { wallet: w.W4, bucket: w.L2, exclusive: false, maxAllocationBps: 5000, logicalAck: true });
  const wca = (id: string) => sql(`select id from wallet_chain_accounts where wallet_id='${id}'`);
  w.wca1 = wca(w.W1); w.wca2 = wca(w.W2); w.wca3 = wca(w.W3); w.wca4 = wca(w.W4);
  w.USDC = sql(`select id from assets where chain_id='eip155:1' and symbol='USDC'`); w.ETH = sql(`select id from assets where chain_id='eip155:1' and symbol='ETH'`);
  const fund = async (wcaId: string, bucket: string, amount: string) => { await ok(page, 'paperDeposit', { workspace: w.ws, walletChainAccount: wcaId, asset: w.USDC, amount }); await ok(page, 'allocate', { workspace: w.ws, bucket, walletChainAccount: wcaId, asset: w.USDC, amount }); };
  await fund(w.wca1, w.A, '1000000000'); await fund(w.wca4, w.L1, '100000000'); await fund(w.wca3, w.V, '500000000');
  w.ownerId = sql(`select user_id from memberships where workspace_id='${w.ws}' and role='owner'`);
  return w as World;
}
/** Adds a SECOND owner (four-eyes tests). The console cannot invite users without Supabase, so this is done at the DB. */
export function addSecondOwner(ws: string): string {
  const id = randomUUID(); sql(`insert into auth.users(id,email) values ('${id}','second-${id.slice(0, 8)}@apex.test'); insert into memberships(workspace_id,user_id,role) values ('${ws}','${id}','owner')`); return id;
}
/** Seeds a reconciled realised profit event (what the settlement pipeline would produce) so progress / waterfall pages have real ledger rows. */
export function seedProfit(w: World, net: string, key = randomUUID()): string {
  const intent = sql(`insert into trade_intents(workspace_id,environment,bucket_id,strategy_key,wallet_chain_account_id,base_asset,quote_asset,side,quantity,notional,idempotency_key,state)
    values ('${w.ws}','paper','${w.A}','e2e-seed','${w.wca1}','${w.ETH}','${w.USDC}','sell',1,1,'${key}','RECONCILED') returning id`).split('\n')[0];
  sql(`insert into profit_eligibility_events(workspace_id,environment,bucket_id,intent_id,quote_asset,realized_net_quote) values ('${w.ws}','paper','${w.A}','${intent}','${w.USDC}',${net})`);
  return intent;
}
export async function waitIdle(page: Page) { await page.waitForLoadState('networkidle').catch(() => undefined); }
