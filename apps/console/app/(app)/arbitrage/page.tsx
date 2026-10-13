'use client';
import { useMemo, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Async, Badge, Card, Kpi, PageHeader, TextInput } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { formatUnits } from '@/lib/format';
import { netEdge, type EdgeInput } from '@/lib/edge';
import { NotConnectedCard, Note } from '@/components/trading/parts';

const bpsToText = (x: bigint) => `${x < 0n ? '-' : ''}${(x < 0n ? -x : x) / 100n}.${((x < 0n ? -x : x) % 100n).toString().padStart(2, '0')}%`;

function Calculator() {
  const [v, setV] = useState({ baseDecimals: '8', quoteDecimals: '6', qty: '1', buyPrice: '100', sellPrice: '100.8', buyFeeBps: '10', sellFeeBps: '10', buySlippageBps: '5', sellSlippageBps: '5', latencyRiskBps: '20', fixedCosts: '0.50' });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
  const res = useMemo(() => {
    const int = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : NaN);
    const bd = int(v.baseDecimals), qd = int(v.quoteDecimals);
    if (!Number.isInteger(bd) || !Number.isInteger(qd) || bd < 0 || qd < 0 || bd > 30 || qd > 30) return { ok: false as const, errors: { baseDecimals: 'Whole number 0-30', quoteDecimals: 'Whole number 0-30' } };
    const input: EdgeInput = { baseDecimals: bd, quoteDecimals: qd, qty: v.qty, buyPrice: v.buyPrice, sellPrice: v.sellPrice, buyFeeBps: int(v.buyFeeBps), sellFeeBps: int(v.sellFeeBps), buySlippageBps: int(v.buySlippageBps), sellSlippageBps: int(v.sellSlippageBps), latencyRiskBps: int(v.latencyRiskBps), fixedCosts: v.fixedCosts };
    return netEdge(input);
  }, [v]);
  const err = (k: string) => (!res.ok ? (res.errors as Record<string, string>)[k] : undefined);
  const qd = Number(v.quoteDecimals);
  const money = (x: bigint) => (Number.isInteger(qd) ? formatUnits(x, qd) : '—');
  return (
    <Card title="Executable net-edge calculator">
      <div className="mb-4 rounded-xl border border-[#f0dfb7] bg-warn-soft p-3 text-[13px] text-warn" role="note"><strong>Calculator, not a scanner.</strong> Every figure comes from the numbers you type below. Nothing on this card is a live opportunity or market price, and it is never fed from or into execution.</div>
      <div className="grid gap-6 lg:grid-cols-2">
        <form className="grid grid-cols-2 gap-3" onSubmit={(e) => e.preventDefault()} aria-label="Calculator inputs">
          <TextInput label="Base decimals" inputMode="numeric" value={v.baseDecimals} onChange={set('baseDecimals')} error={err('baseDecimals')} />
          <TextInput label="Quote decimals" inputMode="numeric" value={v.quoteDecimals} onChange={set('quoteDecimals')} error={err('quoteDecimals')} />
          <TextInput label="Quantity (base units, whole)" inputMode="decimal" value={v.qty} onChange={set('qty')} error={err('qty')} />
          <TextInput label="Fixed costs (quote)" inputMode="decimal" value={v.fixedCosts} onChange={set('fixedCosts')} error={err('fixedCosts')} hint="Gas, withdrawal, bridge" />
          <TextInput label="Buy price (ask, quote per base)" inputMode="decimal" value={v.buyPrice} onChange={set('buyPrice')} error={err('buyPrice')} />
          <TextInput label="Sell price (bid, quote per base)" inputMode="decimal" value={v.sellPrice} onChange={set('sellPrice')} error={err('sellPrice')} />
          <TextInput label="Buy-leg fee (bps)" inputMode="numeric" value={v.buyFeeBps} onChange={set('buyFeeBps')} error={err('buyFeeBps')} />
          <TextInput label="Sell-leg fee (bps)" inputMode="numeric" value={v.sellFeeBps} onChange={set('sellFeeBps')} error={err('sellFeeBps')} />
          <TextInput label="Buy-leg slippage (bps)" inputMode="numeric" value={v.buySlippageBps} onChange={set('buySlippageBps')} error={err('buySlippageBps')} />
          <TextInput label="Sell-leg slippage (bps)" inputMode="numeric" value={v.sellSlippageBps} onChange={set('sellSlippageBps')} error={err('sellSlippageBps')} />
          <div className="col-span-2"><TextInput label="Transfer latency risk allowance (bps)" inputMode="numeric" value={v.latencyRiskBps} onChange={set('latencyRiskBps')} error={err('latencyRiskBps')} hint="Adverse price move you allow for while funds or inventory are in transit or settling." /></div>
        </form>
        <div aria-live="polite">
          {res.ok ? (<>
            <div className="grid gap-3 sm:grid-cols-2">
              <Kpi label="Naive spread" value={`${money(res.naiveSpread)}`} sub={`${bpsToText(res.naiveSpreadBps)} of buy cost (before costs)`} />
              <Kpi label="Executable net edge" value={`${money(res.netEdge)}`} sub={`${bpsToText(res.netEdgeBps)} of buy cost`} tone={res.verdict === 'positive' ? 'good' : 'bad'} />
            </div>
            <p className={res.verdict === 'positive' ? 'mt-3 text-[14px] font-semibold text-good' : 'mt-3 text-[14px] font-semibold text-bad'} role="status">{res.verdict === 'positive' ? 'Positive on these inputs' : res.verdict === 'zero' ? 'Zero edge on these inputs' : 'Negative executable edge on these inputs: do not trade'}</p>
            <table className="mt-3 w-full text-[13px]"><caption className="sr-only">Edge breakdown</caption><tbody>
              {([['Buy cost (rounded up)', res.buyCost], ['Sell proceeds (rounded down)', res.sellProceeds], ['− Buy fee', res.buyFee], ['− Sell fee', res.sellFee], ['− Slippage (both legs)', res.slippage], ['− Transfer latency risk', res.latencyRisk], ['− Fixed costs', res.fixed], ['= Total costs', res.totalCosts]] as [string, bigint][]).map(([k, x]) =>
                <tr key={k} className="border-t border-line"><th scope="row" className="py-1.5 text-left font-normal">{k}</th><td className="tabular py-1.5 text-right">{money(x)}</td></tr>)}
              <tr className="border-t border-line"><th scope="row" className="py-1.5 text-left font-normal">Break-even gross spread</th><td className="tabular py-1.5 text-right">{bpsToText(res.breakevenGrossBps * 100n)}</td></tr></tbody></table>
            <p className="mt-2 text-[11px] text-muted">Amounts in quote units. BigInt arithmetic; costs round up and proceeds round down so the result can only understate the edge.</p>
          </>) : <p className="rounded-xl border border-dashed border-line p-4 text-[13px] text-muted">Fix the highlighted inputs to see a result.</p>}
        </div>
      </div>
    </Card>
  );
}

function Body() {
  const m = useWs<{ feed: { connected: boolean; note: string } }>('market/list', '&limit=1');
  return (<>
    <PageHeader title="Arbitrage & Dislocations" description="Opportunity scanning needs live two-venue order-book depth, wallet inventory and fee schedules. None of that is connected here, so there are no opportunities to list. The calculator below is for what-if sizing with numbers you enter." />
    <div className="mb-5"><Async q={m}>{(d) => (
      <div className="grid gap-4 sm:grid-cols-3">
        <Kpi label="Live opportunities" value="None" sub="The scanner has no two-venue depth to evaluate" tone="warn" />
        <Kpi label="Market data feed" value={d.feed.connected ? 'Reported' : 'None'} sub={d.feed.connected ? 'Still no two-leg depth or inventory' : 'Not connected'} />
        <Kpi label="Auto-routing" value="Never" sub="Experimental edges never bypass the risk gate" />
      </div>)}</Async></div>
    <div className="mb-5 flex items-start gap-3 rounded-xl border border-[#f0dfb7] bg-warn-soft p-4 text-[13px] text-warn" role="note"><ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p><strong>Experimental opportunities never bypass the risk gate.</strong> Any future arbitrage intent is an ordinary trade intent: it must be ADMITTED by the independent risk service, reserve capital, and pass fee and freshness checks. A naive spread is not an executable edge.</p></div>
    <div className="mb-5"><Async q={m}>{(d) => (
      <NotConnectedCard title="No market data feeds connected: the scanner is empty" what={d.feed.connected ? 'A feed is reported, but two-leg executable depth, wallet inventory per venue and fee tiers are still required before any opportunity can be computed.' : d.feed.note}
        setup={['Connect at least two venue adapters that expose order-book snapshots/deltas with sequence numbers (packages/exchange-adapters).', 'Record wallet inventory on both venues (Wallets) so legs are pre-funded.', 'Load fee schedules and tier data per venue so the fee engine can compute round-trip costs.', 'Enable the data-freshness gate: stale books must be rejected before any edge is shown.']} />)}</Async></div>
    <Calculator />
    <div className="mt-5"><Note>Spread ≠ edge. The calculator separates the naive spread from the executable net edge after fees, slippage, fixed costs and transfer-latency risk. A cross-chain or cross-venue leg is never assumed atomic.</Note></div>
  </>);
}
export default function ArbitragePage() { return <NeedWorkspace><Body /></NeedWorkspace>; }
