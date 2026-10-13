'use client';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Async, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Kpi, PageHeader, TabPanel, Tabs, useToast } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { useApi, useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits, when } from '@/lib/format';
import { fillRatioBps, gasCell, pctFromBps, slipCell, stateNote } from '@/lib/orders';
import { EnvBadge, Note, NotConnectedCard } from '@/components/trading/parts';
import { OrderDrawer, type OrderRow } from '@/components/trading/order-drawer';
import { OrderTicket } from '@/components/trading/order-ticket';

const TABS = [{ id: 'orders', label: 'Orders' }, { id: 'positions', label: 'Positions' }, { id: 'fills', label: 'Fills' }];
interface Fill { id: string; intent_id: string; environment: string; venue_fill_id: string; qty: string; quote_amount: string; fee_quote: string; created_at: string; expected_slippage_bps: number | null; realised_slippage_bps: number | null; gas_native: string | null;
  strategy_key: string; side: string; venue: string | null; base_symbol: string; base_decimals: number; quote_symbol: string; quote_decimals: number; chain_id: string; native_symbol: string; native_decimals: number }
interface Pos { bucket_id: string; wallet_chain_account_id: string; base_asset: string; quote_asset: string; environment: string; qty_s: string; cost_s: string; pnl_s: string; bucket_name: string; base_symbol: string; quote_symbol: string }
interface Asset { id: string; decimals: number }

function ExitOnly() {
  const { current, canWrite } = useWorkspace(); const toast = useToast(); const exit = useCommand('enterExitOnly'); const [open, setOpen] = useState(false);
  if (!current) return null;
  if (current.global_state !== 'active') return <Badge tone="bad" title="Set from the emergency controls; resuming needs an owner or admin">{current.global_state.replace(/_/g, ' ')}</Badge>;
  return (<>
    <Button disabled={!canWrite} onClick={() => setOpen(true)}>Exit-only mode</Button>
    <ConfirmDialog open={open} onClose={() => setOpen(false)} busy={exit.isPending} title="Enter exit-only mode" confirmLabel="Enter exit-only"
      body={<><p>Only risk-reducing exits are admitted; <strong>no new entries</strong> in this workspace. Orders in flight keep settling and reconciling.</p><p className="text-muted">Resuming requires an owner or admin.</p></>}
      onConfirm={() => exit.mutate({ body: { workspace: current.id, reason: 'Exit-only from Live Orders' } }, { onSuccess: () => { toast.push('Exit-only mode active'); setOpen(false); }, onError: (e) => { toast.push(e.message, 'bad'); setOpen(false); } })} />
  </>);
}

function OrdersTab({ rows, onOpen }: { rows: OrderRow[]; onOpen: (id: string) => void }) {
  if (rows.length === 0) return <EmptyState title="No orders yet" hint="Orders appear when a strategy proposes an intent or you create a paper order. Nothing here is simulated by the page." />;
  return (<DataTable caption="Orders" onRow={(r) => onOpen(r.id)} rows={rows} cols={[
    { key: 'created_at', header: 'Created', text: (r) => when(r.created_at), sort: (r) => r.created_at },
    { key: 'environment', header: 'Env', filter: true, render: (r) => <EnvBadge env={r.environment} /> },
    { key: 'strategy_key', header: 'Strategy', filter: true },
    { key: 'side', header: 'Side', filter: true },
    { key: 'pair', header: 'Pair', text: (r) => `${r.base_symbol}/${r.quote_symbol}` },
    { key: 'quantity', header: 'Quantity', align: 'right', text: (r) => `${formatUnits(r.quantity, r.base_decimals)} ${r.base_symbol}`, sort: (r) => Number(BigInt(r.quantity) / 10n ** BigInt(Math.max(0, r.base_decimals - 6))) },
    { key: 'state', header: 'State', filter: true, render: (r) => { const n = stateNote({ state: r.state, risk_decision: r.risk_decision });
      return <div className={r.state === 'UNKNOWN' ? 'rounded-lg bg-warn-soft p-2 text-warn' : ''}><Badge tone={r.state === 'UNKNOWN' ? 'warn' : r.state === 'FAILED' ? 'bad' : 'neutral'}>{r.state}</Badge>{n && <div className="mt-1 max-w-[260px] text-[11px] leading-snug">{n.text}</div>}</div>; } },
    { key: 'fill', header: 'Fill ratio', align: 'right', text: (r) => pctFromBps(fillRatioBps(r.filled_qty, r.quantity)) },
    { key: 'slip', header: 'Slippage exp / real', align: 'right', text: (r) => slipCell(r.expected_slippage_bps, r.realised_slippage_bps) },
    { key: 'gas', header: 'Gas', align: 'right', text: (r) => gasCell(r.gas_native, r.native_decimals, r.native_symbol) },
    { key: 'venue', header: 'Venue', text: (r) => r.venue ?? '—' },
    { key: 'view', header: '', text: () => '', render: (r) => <Button variant="ghost" onClick={(e) => { e.stopPropagation(); onOpen(r.id); }} aria-label={`View order ${r.id.slice(0, 8)}`}>View</Button> }]} />);
}

function Body() {
  const orders = useWs<{ items: OrderRow[] }>('orders/board', '&limit=200'), trades = useWs<{ items: Fill[] }>('trades/board', '&limit=200'), positions = useWs<{ items: Pos[] }>('positions'), assets = useApi<{ items: Asset[] }>('v1/assets');
  const [tab, setTab] = useState('orders'); const [open, setOpen] = useState<string | null>(null); const [ticket, setTicket] = useState(false); const { canWrite } = useWorkspace();
  useEffect(() => { const h = window.location.hash.slice(1); if (TABS.some((t) => t.id === h)) setTab(h); }, []);
  const pick = (t: string) => { setTab(t); try { window.history.replaceState(null, '', `#${t}`); } catch { /* ignore */ } };
  const dec = new Map((assets.data?.items ?? []).map((a) => [a.id, a.decimals]));
  return (<>
    <PageHeader title="Live Orders" description="Orders, positions and fills from the execution ledger with paper and live kept apart. Every number is a recorded value; slippage, gas and PnL that were not recorded show an em dash."
      actions={<><ExitOnly /><Button variant="primary" disabled={!canWrite} onClick={() => setTicket(true)}><Plus className="size-4" aria-hidden />New paper order</Button></>} />
    <Async q={orders}>{(o) => {
      const by = (env: string) => o.items.filter((x) => x.environment === env);
      const unknown = o.items.filter((x) => x.state === 'UNKNOWN').length; const waiting = o.items.filter((x) => x.state === 'RISK_EVALUATING' && !x.risk_decision).length;
      return (<>
        <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Paper orders" value={by('paper').length} sub="Simulated; no real wallet is touched" />
          <Kpi label="Live orders" value={by('live').length} sub={by('live').length ? 'Real environment' : 'Live is locked behind the deployment gates'} tone="warn" />
          <Kpi label="UNKNOWN" value={unknown} sub={unknown ? 'Awaiting reconciliation; never blindly retried' : 'None'} tone={unknown ? 'warn' : undefined} />
          <Kpi label="Waiting for risk" value={waiting} sub={waiting ? 'The risk service has not decided these yet' : 'None'} tone={waiting ? 'warn' : undefined} />
        </div>
        {waiting > 0 && <div className="mb-5"><Note tone="warn">{waiting} order(s) are <strong>waiting for the risk service</strong>. No order proceeds without an independent ADMIT; if the risk service is not running they stay in RISK_EVALUATING.</Note></div>}
        <Card><Tabs tabs={TABS} value={tab} onChange={pick} />
          <TabPanel id="orders" value={tab}><OrdersTab rows={o.items} onOpen={setOpen} /></TabPanel>
          <TabPanel id="positions" value={tab}><Async q={positions}>{(p) => p.items.length === 0 ? <EmptyState title="No positions" hint="Positions are created by recorded fills." /> : (<>
            <DataTable caption="Positions" rows={p.items.map((x, i) => ({ ...x, id: String(i) }))} cols={[
              { key: 'bucket_name', header: 'Bucket' }, { key: 'environment', header: 'Env', filter: true, render: (x) => <EnvBadge env={x.environment} /> },
              { key: 'pair', header: 'Pair', text: (x) => `${x.base_symbol}/${x.quote_symbol}` },
              { key: 'qty', header: 'Quantity', align: 'right', text: (x) => formatUnits(x.qty_s, dec.get(x.base_asset) ?? 0) + ' ' + x.base_symbol },
              { key: 'cost', header: 'Cost basis', align: 'right', text: (x) => `${formatUnits(x.cost_s, dec.get(x.quote_asset) ?? 0)} ${x.quote_symbol}` },
              { key: 'pnl', header: 'Realised PnL', align: 'right', text: (x) => `${formatUnits(x.pnl_s, dec.get(x.quote_asset) ?? 0)} ${x.quote_symbol}` },
              { key: 'unreal', header: 'Unrealised PnL', align: 'right', text: () => 'Not priced', render: () => <Badge title="No market-price feed is connected, so open positions cannot be marked to market">Not priced (no feed)</Badge> }]} />
            <div className="mt-3"><Note>Unrealised PnL is not computed: no price feed is connected, and APEX will not show a stale or invented mark.</Note></div></>)}</Async></TabPanel>
          <TabPanel id="fills" value={tab}><Async q={trades}>{(t) => t.items.length === 0 ? <EmptyState title="No fills yet" hint="Fills are recorded by the execution service; a successful order request is never treated as a fill." /> :
            <DataTable caption="Fills" rows={t.items} cols={[
              { key: 'created_at', header: 'Time', text: (f) => when(f.created_at), sort: (f) => f.created_at }, { key: 'environment', header: 'Env', filter: true, render: (f) => <EnvBadge env={f.environment} /> },
              { key: 'strategy_key', header: 'Strategy', filter: true }, { key: 'side', header: 'Side', filter: true }, { key: 'pair', header: 'Pair', text: (f) => `${f.base_symbol}/${f.quote_symbol}` },
              { key: 'qty', header: 'Quantity', align: 'right', text: (f) => formatUnits(f.qty, f.base_decimals) }, { key: 'quote', header: 'Quote amount', align: 'right', text: (f) => formatUnits(f.quote_amount, f.quote_decimals) },
              { key: 'fee', header: 'Fee', align: 'right', text: (f) => formatUnits(f.fee_quote, f.quote_decimals) }, { key: 'slip', header: 'Slippage exp / real', align: 'right', text: (f) => slipCell(f.expected_slippage_bps, f.realised_slippage_bps) },
              { key: 'gas', header: 'Gas', align: 'right', text: (f) => gasCell(f.gas_native, f.native_decimals, f.native_symbol) }, { key: 'venue', header: 'Venue', text: (f) => f.venue ?? '—' }]} />}</Async></TabPanel>
        </Card>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <NotConnectedCard title="Wallet signer scope and blockchain finality" what="Per-order signer scope and on-chain finality depth are shown only once the execution service records them. Today the order timeline reflects state-machine events only." setup={['Connect a certified chain adapter with getTransactionStatus and finalityStatus.', 'Run the execution service so submissions and confirmations are recorded as order events.']} />
          <NotConnectedCard title="Dynamic PnL" what="Open-position PnL needs a market-price feed with freshness checks." setup={['Connect a market data feed (see Markets).', 'Prices older than the staleness budget will be shown with a stale badge, never as live.']} />
        </div>
      </>);
    }}</Async>
    <OrderDrawer id={open} onClose={() => setOpen(null)} />
    <OrderTicket open={ticket} onClose={() => setTicket(false)} />
  </>);
}
export default function TradingPage() { return <NeedWorkspace><Body /></NeedWorkspace>; }
