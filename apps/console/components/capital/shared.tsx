'use client';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ShieldCheck, KeyRound, Lock } from 'lucide-react';
import { Badge, Card, Field, Select, inputCls, cx } from '@/components/ui';
import { useWs } from '@/components/hooks';
import { useApi } from '@/lib/api';
import { formatUnits, parseUnits } from '@/lib/format';

// ---------- API row types (shapes returned by services/api) ----------
export interface PortfolioRow { id: string; name: string; environment: 'paper' | 'live' }
export interface BucketRow { id: string; portfolio_id: string; name: string; environment: 'paper' | 'live'; kind: string; segregation: 'physical' | 'logical' | 'protected'; state: string; policy: Record<string, unknown>; policy_version: number; wallet_count: number; created_at: string }
export interface WalletRow { id: string; nickname: string; family: string; address: string; capability: string; state: 'active' | 'paused' | 'archived' | 'revoked'; created_at: string; allocations: { bucket_id: string; exclusive: boolean; bps: number }[]; chains: string[] }
export interface AssetRow { id: string; chain_id: string; contract: string; symbol: string; decimals: number }
export interface ChainRow { id: string; name: string; family: string; native_symbol: string; is_testnet: boolean; enabled: boolean; capabilities: Record<string, { status: string; evidence: string | null }> }
export interface WalletAccount { id: string; wallet_id: string; chain_id: string; chain_name: string; native_symbol: string; nickname: string; family: string; address: string; capability: string; state: string }
export interface AcctBalance { wca: string; bucket_id: string | null; environment: string; state: string; asset: string; symbol: string; decimals: number; amount: string }

export const useAssets = () => useApi<{ items: AssetRow[] }>('v1/assets');
export const useChains = () => useApi<{ items: ChainRow[] }>('v1/chain-registry');
export const usePortfolios = () => useWs<{ items: PortfolioRow[] }>('portfolios');
export const useBuckets = () => useWs<{ items: BucketRow[] }>('buckets');
export const useWallets = () => useWs<{ items: WalletRow[] }>('wallets');
export const useWalletAccounts = () => useWs<{ accounts: WalletAccount[]; balances: AcctBalance[]; note: string }>('wallets/accounts');

// ---------- badges ----------
export const EnvBadge = ({ env }: { env: string }) => <Badge tone={env === 'live' ? 'bad' : 'accent'} title={env === 'live' ? 'Live environment (real funds)' : 'Paper environment: simulated ledger, no real funds'}>{env}</Badge>;
const SEG: Record<string, { tone: 'good' | 'warn' | 'accent'; text: string; title: string }> = {
  physical: { tone: 'good', text: 'Physical', title: 'Dedicated wallet(s): security-level separation' },
  logical: { tone: 'warn', text: 'Logical', title: 'Accounting separation only; the wallet may be shared. No wallet-level security segregation.' },
  protected: { tone: 'accent', text: 'Protected', title: 'Vault: funds need approval and a delay to leave' },
};
export const SegBadge = ({ seg }: { seg: string }) => { const s = SEG[seg] ?? { tone: 'warn' as const, text: seg, title: '' }; return <Badge tone={s.tone} title={s.title}>{s.text}</Badge>; };
export const WALLET_STATE_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { active: 'good', paused: 'warn', archived: 'neutral', revoked: 'bad' };
export const WalletStateBadge = ({ state }: { state: string }) => <Badge tone={WALLET_STATE_TONE[state] ?? 'neutral'}>{state}</Badge>;
export const CAPABILITY_LABEL: Record<string, string> = { watch_only: 'Watch-only', user_signed: 'User-signed', managed_signer: 'Managed signer', cex_view_only: 'CEX view-only', cex_trade_only: 'CEX trade-only' };
export const CapabilityBadge = ({ cap }: { cap: string }) => <Badge tone={cap === 'managed_signer' ? 'warn' : 'neutral'}>{CAPABILITY_LABEL[cap] ?? cap}</Badge>;

/** Environment-honest wrapper phrase for anything funded through the UI. */
export const PaperLabel = () => <Badge tone="warn" title="This changes the PAPER ledger only. No on-chain transaction is made and no real funds move.">PAPER ledger funding</Badge>;

export function NoKeysNote({ compact }: { compact?: boolean }) {
  return (
    <div role="note" className="flex items-start gap-3 rounded-xl border border-[#bfe6d9] bg-good-soft p-3 text-[13px] text-good">
      <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p><strong>APEX never asks for keys.</strong> {compact ? 'No seed phrase, private key or API secret is ever entered here.' : 'There is no seed phrase, private key, mnemonic or exchange API secret field anywhere in APEX. You register a public address (or an exchange account reference) only. Signing stays in your wallet, hardware device or the separate signer service.'}</p>
    </div>
  );
}

export function SegregationExplainer({ highlight }: { highlight?: string }) {
  const items = [
    { id: 'physical', t: 'Physical (preferred)', d: 'The wallet or CEX sub-account belongs exclusively to this bucket. A compromise of another bucket cannot reach these funds. This is the only mode that gives wallet-level risk isolation.' },
    { id: 'logical', t: 'Logical', d: 'Several buckets share one wallet and are separated by the APEX ledger only. Balances are locked atomically so buckets cannot overspend each other, but there is NO wallet-level security segregation: one wallet compromise affects every bucket on it.' },
    { id: 'protected', t: 'Protected / cold', d: 'A vault. Funds are never tradeable by strategy workers. Moving them out needs a separate owner approval and a withdrawal delay (24h by default).' },
  ];
  return (
    <dl className="grid gap-2 sm:grid-cols-3">{items.map((i) => (
      <div key={i.id} className={cx('rounded-xl border p-3', highlight === i.id ? 'border-accent bg-accent-soft' : 'border-line bg-white')}>
        <dt className="mb-1 flex items-center gap-2 text-[13px] font-semibold">{i.id === 'protected' ? <Lock className="size-4" aria-hidden /> : <ShieldCheck className="size-4" aria-hidden />}{i.t}</dt>
        <dd className="text-[12px] text-muted">{i.d}</dd>
      </div>))}</dl>
  );
}

/** Decimal amount input bound to an asset: shows base-unit string result; BigInt only. */
export function AmountInput({ label, decimals, symbol, value, onChange, hint, max }: { label: string; decimals: number | null; symbol?: string; value: string; onChange: (v: string) => void; hint?: string; max?: bigint }) {
  const id = useId(); let err: string | undefined; let base: string | null = null;
  if (value && decimals !== null) { try { base = parseUnits(value, decimals); if (BigInt(base) === 0n) { err = 'Must be greater than zero'; base = null; } else if (max !== undefined && BigInt(base) > max) { err = `Exceeds available ${formatUnits(max, decimals)} ${symbol ?? ''}`; } } catch (e) { err = (e as Error).message; } }
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12px] font-semibold text-[#44546a]">{label}{symbol ? ` (${symbol})` : ''}</label>
      <input id={id} inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!err} aria-describedby={id + 'h'} className={inputCls} placeholder="0.0" disabled={decimals === null} />
      <p id={id + 'h'} className={cx('mt-1 text-[12px]', err ? 'text-bad' : 'text-muted')} role={err ? 'alert' : undefined}>{err ?? (base && decimals !== null ? `= ${base} base units (${decimals} decimals)` : hint ?? 'Decimal amount; converted to integer base units without floating point.')}</p>
    </div>
  );
}
export const amountToBase = (v: string, decimals: number | null): string | null => { if (!v || decimals === null) return null; try { const b = parseUnits(v, decimals); return BigInt(b) > 0n ? b : null; } catch { return null; } };

export function AssetSelect({ label, assets, value, onChange, filter }: { label: string; assets: AssetRow[]; value: string; onChange: (v: string) => void; filter?: (a: AssetRow) => boolean }) {
  const list = useMemo(() => assets.filter((a) => !filter || filter(a)), [assets, filter]);
  return <Select label={label} value={value} onChange={(e) => onChange(e.target.value)} options={[{ value: '', label: list.length ? 'Choose an asset…' : 'No assets registered' }, ...list.map((a) => ({ value: a.id, label: `${a.symbol} · ${a.chain_id}${a.contract === 'native' ? ' (native)' : ''}` }))]} />;
}

/** One idempotency key per user action; stays stable across double-clicks/retries, rotates after success. */
export function useActionKey() {
  const ref = useRef<string>(typeof crypto !== 'undefined' ? crypto.randomUUID() : String(Math.random()));
  return { get: () => ref.current, rotate: () => { ref.current = crypto.randomUUID(); } };
}

export function ReasonList({ title, reasons }: { title: string; reasons: string[] }) {
  return <div className="rounded-xl border border-[#f0dfb7] bg-warn-soft p-3 text-[13px] text-warn"><p className="font-semibold">{title}</p><ul className="mt-1 list-disc pl-5">{reasons.map((r) => <li key={r}>{r}</li>)}</ul></div>;
}
export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) { return <span title={title} className={cx('break-all font-mono text-[12px]', className)}>{children}</span>; }

/** Reasons live portfolios are locked, derived from real workspace/risk data (never hardcoded). */
export function liveLockReasons(ws: { live_allowed: boolean; live_feature_flag: boolean; live_opt_in: boolean; global_state?: string }, gates: { status: string }[] | null): string[] {
  const r: string[] = [];
  if (!ws.live_feature_flag) r.push('Live feature flag is off for this workspace.');
  if (!ws.live_opt_in) r.push('The owner has not opted in to live trading.');
  if (ws.global_state && ws.global_state !== 'active') r.push(`Global state is ${ws.global_state.replace(/_/g, ' ')}.`);
  if (gates) { const pass = gates.filter((g) => g.status === 'PASS').length; if (pass < gates.length) r.push(`${gates.length - pass} of ${gates.length} deployment gates are not PASS (each needs recorded evidence).`); } else r.push('Deployment gate status could not be read.');
  if (r.length === 0 && !ws.live_allowed) r.push('live_allowed() is false for this workspace.');
  return r;
}
export function useExpandable() { const [open, setOpen] = useState(false); return { open, toggle: () => setOpen((o) => !o) }; }
export { Card, Field };
