'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Async, Badge, Card, DataTable, EmptyState, Kpi, PageHeader, TabPanel, Tabs } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { ADAPTER_PACKAGE, ALL_CAPABILITIES, effectiveStatus, readiness, type CapMap } from '@/lib/chains';
import { formatUnits, when } from '@/lib/format';
import { CapBadge, EnvBadge, HealthBadge, NotConnectedCard, Note, ReadinessBadges, amt, fmtDur, ms, type Health } from '@/components/trading/parts';

const TABS = ['Nodes', 'Providers', 'Fees', 'Wallets', 'Markets', 'Transactions', 'Incidents', 'Adapters'].map((t) => ({ id: t.toLowerCase(), label: t }));
interface Detail {
  chain: { id: string; family: string; name: string; namespace: string; chain_ref: string; is_testnet: boolean; native_symbol: string; native_decimals: number; finality_model: string; address_format: string; explorer_url: string | null; enabled: boolean; policy_reason: string | null; registry_unverified: boolean; unverified_fields: string[]; capabilities: CapMap };
  health: Health; candidates: string[]; probes: { configured: boolean };
  history: { endpoint: string; observed_at: string; ok: boolean; latency_ms: number | null; chain_id_match: boolean | null; block_height: string | null; error: string | null }[];
  providers: { endpoint: string; samples: number; ok_samples: number; p50: number | null; last_seen: string }[];
  wallets: { wallet_id: string; wca_id: string; nickname: string; family: string; address: string; capability: string; state: string; buckets: { bucket: string; exclusive: boolean }[]; balances: { environment: string; symbol: string; contract: string; decimals: number; state: string; amount: string }[] }[];
  markets: { id: string; contract: string; symbol: string; decimals: number; token_program: string | null }[];
  transactions: { id: string; environment: string; state: string; side: string; strategy_key: string; created_at: string }[];
  fees: { environment: string; symbol: string; decimals: number; fills: number; fee_quote: string; gas_native: string | null; gas_recorded: number }[];
  incidents: { kind: string; label: string; detail: string; ts: string }[];
}

const PROBE_SETUP = ['Run the API with APEX_PROBES=1 and APEX_PROBES_DATABASE_URL pointing at a service-role connection (read-only JSON-RPC probes: eth_chainId, eth_getBlockByNumber / getHealth, getSlot).', 'Enable this chain for the workspace (only enabled chains are probed).', 'The registry must list RPC candidates for the chain; each probe verifies the reported chain id before the endpoint can count as healthy.'];

function Nodes({ d }: { d: Detail }) {
  const rows = d.candidates.map((origin) => { const e = d.health.endpoints.find((x) => x.endpoint === origin); return { id: origin, origin, e }; });
  return (<div className="space-y-4">
    <Note>Endpoint URLs are shown as origins only: RPC URLs often embed API keys, so paths and query strings never leave the API. {d.health.note}</Note>
    {rows.length === 0 ? <NotConnectedCard title="No RPC candidates in the registry" what="This chain has no RPC endpoints recorded, so nothing can be probed." setup={['Add trusted RPC candidates (official documentation) to the chain registry record.', ...PROBE_SETUP.slice(1)]} />
      : <DataTable caption="RPC endpoints" rows={rows} cols={[
        { key: 'origin', header: 'Endpoint' },
        { key: 'status', header: 'Status', text: (r) => r.e?.status ?? 'NOT_MEASURED', filter: true, render: (r) => r.e ? <HealthBadge health={r.e} /> : <Badge title="No fresh probe sample">Not measured</Badge> },
        { key: 'lat', header: 'Latency', align: 'right', sort: (r) => r.e?.latencyMs ?? -1, text: (r) => ms(r.e?.latencyMs) },
        { key: 'height', header: 'Block', align: 'right', text: (r) => r.e?.blockHeight ?? '—' },
        { key: 'age', header: 'Block age', align: 'right', sort: (r) => r.e?.blockAgeMs ?? -1, text: (r) => fmtDur(r.e?.blockAgeMs) },
        { key: 'match', header: 'Chain id', text: (r) => (r.e?.chainIdMatch === true ? 'verified' : r.e?.chainIdMatch === false ? 'MISMATCH' : 'unverified') },
        { key: 'obs', header: 'Observed', text: (r) => (r.e ? when(r.e.observedAt) : '—') }]} />}
    {d.health.status === 'NOT_MEASURED' && <NotConnectedCard title="Probing is not producing samples" what={d.health.reason} setup={PROBE_SETUP} />}
    <h3 className="text-[13px] font-semibold">RPC reconciliation: recent probe history</h3>
    {d.history.length === 0 ? <EmptyState title="No probe history" hint="Samples appear here once a probe has run." />
      : <DataTable caption="Recent probe samples" rows={d.history.map((h, i) => ({ ...h, id: String(i) }))} cols={[
        { key: 'observed_at', header: 'Time', text: (h) => when(h.observed_at), sort: (h) => h.observed_at }, { key: 'endpoint', header: 'Endpoint' },
        { key: 'ok', header: 'Result', text: (h) => (h.ok ? 'ok' : 'failed'), filter: true, render: (h) => <Badge tone={h.ok ? 'good' : 'bad'}>{h.ok ? 'OK' : 'Failed'}</Badge> },
        { key: 'latency_ms', header: 'Latency', align: 'right', text: (h) => ms(h.latency_ms) }, { key: 'error', header: 'Error', text: (h) => h.error ?? '—' }]} />}
  </div>);
}
function Providers({ d }: { d: Detail }) {
  return (<div className="space-y-4">
    {d.providers.length === 0 ? <NotConnectedCard title="No provider telemetry" what="Provider success rates and latency are computed from recorded probe samples in the last 24 hours. None exist." setup={PROBE_SETUP} />
      : <DataTable caption="RPC providers (24h)" rows={d.providers.map((p) => ({ ...p, id: p.endpoint }))} cols={[
        { key: 'endpoint', header: 'Provider (origin)' }, { key: 'samples', header: 'Samples', align: 'right', sort: (p) => p.samples },
        { key: 'rate', header: 'Success rate', align: 'right', sort: (p) => p.ok_samples / p.samples, text: (p) => `${((p.ok_samples / p.samples) * 100).toFixed(1)}%` },
        { key: 'p50', header: 'p50 latency', align: 'right', text: (p) => ms(p.p50) }, { key: 'last_seen', header: 'Last sample', text: (p) => when(p.last_seen) }]} />}
    <Note>Provider failover, WebSocket health, indexing lag and rate-limit headroom are not measured by this deployment; they are not displayed rather than guessed.</Note>
  </div>);
}
function Fees({ d }: { d: Detail }) {
  const caps = d.chain.capabilities;
  return (<div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-line p-4"><p className="text-[12px] font-semibold uppercase tracking-wider text-muted">getFeeQuote</p><div className="mt-1"><CapBadge status={effectiveStatus(caps.getFeeQuote)} /></div></div>
      <div className="rounded-xl border border-line p-4"><p className="text-[12px] font-semibold uppercase tracking-wider text-muted">getPriorityFeeQuote</p><div className="mt-1"><CapBadge status={effectiveStatus(caps.getPriorityFeeQuote)} /></div></div></div>
    <NotConnectedCard title="Gas price distribution: not available" what="No fee-quote history is stored. The gas distribution chart appears only when a certified fee adapter records quotes." setup={['Certify getFeeQuote for this chain in the adapter package (evidence required).', 'Record fee quotes through the execution service.']} />
    <h3 className="text-[13px] font-semibold">Fees paid in the ledger (fills on this chain)</h3>
    {d.fees.length === 0 ? <EmptyState title="No fills on this chain yet" hint="Fees are summed from recorded fills only." />
      : <DataTable caption="Fees from fills" rows={d.fees.map((f, i) => ({ ...f, id: String(i) }))} cols={[
        { key: 'environment', header: 'Env', filter: true, render: (f) => <EnvBadge env={f.environment} /> }, { key: 'symbol', header: 'Quote asset' }, { key: 'fills', header: 'Fills', align: 'right', sort: (f) => f.fills },
        { key: 'fee_quote', header: 'Trading fees', align: 'right', text: (f) => amt(f.fee_quote, f.decimals) },
        { key: 'gas', header: 'Gas (native)', align: 'right', text: (f) => (f.gas_native == null ? '— (not recorded)' : amt(f.gas_native, d.chain.native_decimals, d.chain.native_symbol)) }]} />}
  </div>);
}
function Wallets({ d }: { d: Detail }) {
  const rows = d.wallets.map((w) => {
    const nativeBal = w.balances.filter((b) => b.contract === 'native' && ['available', 'fee_reserve'].includes(b.state)).reduce((a, b) => a + BigInt(b.amount), 0n);
    const other = w.balances.some((b) => b.contract !== 'native' && BigInt(b.amount) > 0n);
    return { ...w, id: w.wca_id, stranded: other && nativeBal === 0n, nativeBal };
  });
  return (<div className="space-y-4">
    <Note>Balances are internal-ledger balances (paper or reconciled), not on-chain reads. "No native gas" means the ledger holds other assets for this wallet but no {d.chain.native_symbol} for fees.</Note>
    {rows.length === 0 ? <EmptyState title="No wallets on this chain" hint="Connect a watch-only wallet with this chain from the Wallets page." action={<Link className="font-semibold text-accent underline" href="/wallets">Go to Wallets</Link>} />
      : <DataTable caption="Wallet accounts on this chain" rows={rows} cols={[
        { key: 'nickname', header: 'Wallet', render: (w) => <Link className="font-semibold text-accent hover:underline" href={`/wallets/${w.wallet_id}`}>{w.nickname}</Link> },
        { key: 'address', header: 'Address', text: (w) => `${w.address.slice(0, 8)}…${w.address.slice(-6)}` }, { key: 'capability', header: 'Capability', filter: true }, { key: 'state', header: 'State', filter: true },
        { key: 'buckets', header: 'Bucket (segregation)', text: (w) => (w.buckets.length ? w.buckets.map((b) => `${b.bucket} (${b.exclusive ? 'physical' : 'logical, shared'})`).join(', ') : 'Unassigned') },
        { key: 'native', header: `Native ${d.chain.native_symbol}`, align: 'right', sort: (w) => Number(w.nativeBal / 10n ** 12n), text: (w) => formatUnits(w.nativeBal, d.chain.native_decimals) },
        { key: 'stranded', header: 'Gas check', text: (w) => (w.stranded ? 'No native gas' : 'ok'), filter: true, render: (w) => (w.stranded ? <Badge tone="warn">No native gas</Badge> : <span className="text-muted">—</span>) }]} />}
  </div>);
}
function Markets({ d }: { d: Detail }) {
  return (<div className="space-y-4">
    {d.markets.length === 0 ? <EmptyState title="No assets registered on this chain" /> : <DataTable caption="Registered assets" rows={d.markets} cols={[
      { key: 'symbol', header: 'Symbol' }, { key: 'contract', header: 'Contract / mint', text: (m) => (m.contract.length > 20 ? `${m.contract.slice(0, 10)}…${m.contract.slice(-6)}` : m.contract) }, { key: 'decimals', header: 'Decimals', align: 'right', sort: (m) => m.decimals }, { key: 'token_program', header: 'Token program', text: (m) => m.token_program ?? '—' }]} />}
    <Note>Identity only: no market-price or liquidity feed is connected, so there are no prices here. <Link className="font-semibold underline" href="/markets">Markets</Link> shows the same canonical identities.</Note>
  </div>);
}
function Transactions({ d }: { d: Detail }) {
  return d.transactions.length === 0 ? <EmptyState title="No orders on this chain" hint="Order intents whose wallet account is on this chain appear here. No on-chain transaction hashes are recorded yet." action={<Link className="font-semibold text-accent underline" href="/trading">Go to Live Orders</Link>} />
    : <DataTable caption="Order intents on this chain" rows={d.transactions} cols={[
      { key: 'created_at', header: 'Created', text: (t) => when(t.created_at), sort: (t) => t.created_at }, { key: 'environment', header: 'Env', filter: true, render: (t) => <EnvBadge env={t.environment} /> },
      { key: 'strategy_key', header: 'Strategy' }, { key: 'side', header: 'Side', filter: true }, { key: 'state', header: 'State', filter: true, render: (t) => <Badge tone={t.state === 'UNKNOWN' ? 'warn' : 'neutral'}>{t.state}</Badge> }]} />;
}
function Incidents({ d }: { d: Detail }) {
  return d.incidents.length === 0 ? <EmptyState title="No incidents recorded" hint="Policy changes, chain-id mismatches and failed probes for this chain are listed here." />
    : <DataTable caption="Chain incidents" rows={d.incidents.map((x, i) => ({ ...x, id: String(i) }))} cols={[
      { key: 'ts', header: 'Time', text: (x) => when(x.ts), sort: (x) => x.ts }, { key: 'kind', header: 'Source', filter: true, render: (x) => <Badge tone={x.kind === 'rpc' ? 'bad' : 'neutral'}>{x.kind}</Badge> },
      { key: 'label', header: 'Event' }, { key: 'detail', header: 'Detail', text: (x) => (x.detail ? x.detail.slice(0, 160) : '—') }]} />;
}
function Adapters({ d }: { d: Detail }) {
  const rows = ALL_CAPABILITIES.map((c) => ({ id: c, cap: c, rec: d.chain.capabilities[c], eff: effectiveStatus(d.chain.capabilities[c]) }));
  return (<div className="space-y-4">
    <Note>Expected adapter package for the {d.chain.family} family: <code>{ADAPTER_PACKAGE[d.chain.family] ?? 'none'}</code>. Adapter status is the capability records below, nothing more; a capability is CERTIFIED only with a recorded evidence reference.</Note>
    <DataTable caption="Adapter capability records" rows={rows} cols={[
      { key: 'cap', header: 'Capability' }, { key: 'eff', header: 'Status', filter: true, text: (r) => r.eff, render: (r) => <CapBadge status={r.eff} /> },
      { key: 'evidence', header: 'Evidence', text: (r) => r.rec?.evidence ?? '—' }, { key: 'updated', header: 'Updated', text: (r) => (r.rec?.updated_at ? when(r.rec.updated_at) : '—') }]} />
  </div>);
}

function Body({ id }: { id: string }) {
  const q = useWs<Detail>(`chains/${id}/detail`); const [tab, setTab] = useState('nodes');
  useEffect(() => { const h = window.location.hash.slice(1); if (TABS.some((t) => t.id === h)) setTab(h); }, []);
  const pick = (t: string) => { setTab(t); try { window.history.replaceState(null, '', `#${t}`); } catch { /* ignore */ } };
  return (
    <Async q={q}>{(d) => {
      const r = readiness(d.chain.capabilities);
      return (<>
        <PageHeader title={d.chain.name} description={`${d.chain.id} · ${d.chain.family} · ${d.chain.native_symbol} (${d.chain.native_decimals} dp) · finality: ${d.chain.finality_model}`}
          actions={<Link href="/chains" className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-line bg-white px-4 text-[13px] font-semibold"><ArrowLeft className="size-4" aria-hidden />All chains</Link>} />
        <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Health" value={<HealthBadge health={d.health} />} sub={d.health.reason} />
          <Kpi label="Workspace policy" value={d.chain.enabled ? 'Monitoring on' : 'Disabled'} sub={d.chain.policy_reason ?? 'Enabling never grants trading'} />
          <Kpi label="Capabilities" value={`${r.counts.CERTIFIED} certified`} sub={`${r.counts.READ_ONLY} read-only · ${r.counts.PENDING} pending · ${r.counts.UNSUPPORTED} unsupported · ${r.counts.UNRECORDED} unrecorded`} />
          <Kpi label="Readiness" value={<ReadinessBadges caps={d.chain.capabilities} />} sub={r.trading === 'certified' ? 'Deployment gates still apply' : `Missing CERTIFIED: ${r.missingForTrading.join(', ')}`} tone="warn" />
        </div>
        {d.chain.registry_unverified && <div className="mb-4"><Note tone="warn">This registry record has fields not yet verified against primary sources: <strong>{d.chain.unverified_fields.join(', ') || 'unspecified'}</strong>. Treat them as unconfirmed.</Note></div>}
        {d.chain.explorer_url && <p className="mb-4 text-[13px] text-muted">Explorer: <a className="font-semibold text-accent underline" href={d.chain.explorer_url} target="_blank" rel="noopener noreferrer">{d.chain.explorer_url}</a></p>}
        <Card><Tabs tabs={TABS} value={tab} onChange={pick} />
          <TabPanel id="nodes" value={tab}><Nodes d={d} /></TabPanel><TabPanel id="providers" value={tab}><Providers d={d} /></TabPanel><TabPanel id="fees" value={tab}><Fees d={d} /></TabPanel>
          <TabPanel id="wallets" value={tab}><Wallets d={d} /></TabPanel><TabPanel id="markets" value={tab}><Markets d={d} /></TabPanel><TabPanel id="transactions" value={tab}><Transactions d={d} /></TabPanel>
          <TabPanel id="incidents" value={tab}><Incidents d={d} /></TabPanel><TabPanel id="adapters" value={tab}><Adapters d={d} /></TabPanel></Card>
      </>);
    }}</Async>
  );
}
export default function ChainDetailPage() {
  const { chain } = useParams<{ chain: string }>(); let id = chain; try { id = decodeURIComponent(chain); } catch { /* keep raw */ }
  return <NeedWorkspace><Body id={id} /></NeedWorkspace>;
}
