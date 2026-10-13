'use client';
import { useMemo, useState } from 'react';
import { Badge, Card, TextInput } from '@/components/ui';
import { formatUnits, parseUnits } from '@/lib/format';
import { formatBps, planRoundTrip, type PlannerInput } from '@/lib/markets/planner';
import type { GateResult } from './gate';

const intBps = (s: string, name: string, min = 0n, max = 10_000n): bigint => { if (!/^-?\d+$/.test(s.trim())) throw new Error(`${name} must be a whole number of basis points`); const v = BigInt(s.trim()); if (v < min || v > max) throw new Error(`${name} must be between ${min} and ${max} bps`); return v; };

export function TradePlanner({ gate, taxHint }: { gate: GateResult | null; taxHint: { buy?: string; sell?: string } }) {
  const [f, setF] = useState({ symbol: 'USDC', decimals: '6', notional: '1000', fee: '30', slip: '50', gasIn: '0', gasOut: '0', fail: '0', move: '0', depth: '' });
  const [buyTax, setBuyTax] = useState<string | null>(null), [sellTax, setSellTax] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const out = useMemo(() => {
    try {
      const dec = Number(f.decimals); if (!Number.isInteger(dec) || dec < 0 || dec > 18) throw new Error('Decimals must be 0 to 18');
      const input: PlannerInput = { notional: BigInt(parseUnits(f.notional, dec)), entryFeeBps: intBps(f.fee, 'Fee'), exitFeeBps: intBps(f.fee, 'Fee'), entrySlippageBps: intBps(f.slip, 'Slippage'), exitSlippageBps: intBps(f.slip, 'Slippage'),
        buyTaxBps: intBps(buyTax ?? taxHint.buy ?? '0', 'Buy tax'), sellTaxBps: intBps(sellTax ?? taxHint.sell ?? '0', 'Sell tax'), gasEntry: BigInt(parseUnits(f.gasIn || '0', dec)), gasExit: BigInt(parseUnits(f.gasOut || '0', dec)),
        failedTxProbBps: intBps(f.fail, 'Failed-tx probability', 0n, 9_999n), grossMoveBps: intBps(f.move, 'Gross move', -9_999n, 1_000_000n), exitDepth: f.depth.trim() ? BigInt(parseUnits(f.depth, dec)) : undefined };
      return { r: planRoundTrip(input), dec };
    } catch (e) { return { err: (e as Error).message }; }
  }, [f, buyTax, sellTax, taxHint]);
  const money = (x: bigint) => (out.r ? formatUnits(x, out.dec!, 6) : '');
  const status = !gate ? { tone: 'warn' as const, text: 'Security gate not run. No entry is permitted without a passing gate.' } : gate.stage1_passed ? (gate.admitted_by_strategy ? { tone: 'good' as const, text: 'Gate passed and strategy admission passed. Economics below are still a plan, not an order.' } : { tone: 'warn' as const, text: 'Gate passed but strategy admission did not. Do not enter.' }) : { tone: 'bad' as const, text: 'Gate REJECTED this token. The plan below is shown for arithmetic only and is NOT PERMITTED.' };
  return (
    <Card title="Protected trade planner">
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]"><Badge tone={status.tone}>{status.text}</Badge></div>
      <p className="mb-4 text-[13px] text-muted">Net round-trip economics for a planned spot trade, computed in integer base units in your browser. <strong>No auto-buy:</strong> every entry must pass the universal security gate, strategy admission and the risk gate. This planner cannot place an order, and the price move is your hypothesis, not a forecast.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextInput label="Quote currency" value={f.symbol} onChange={set('symbol')} maxLength={12} />
        <TextInput label="Quote decimals" type="number" min={0} max={18} value={f.decimals} onChange={set('decimals')} />
        <TextInput label="Entry notional" inputMode="decimal" value={f.notional} onChange={set('notional')} />
        <TextInput label="Venue fee per side (bps)" inputMode="numeric" value={f.fee} onChange={set('fee')} />
        <TextInput label="Slippage per side (bps)" inputMode="numeric" value={f.slip} onChange={set('slip')} />
        <TextInput label="Buy tax (bps)" inputMode="numeric" value={buyTax ?? taxHint.buy ?? '0'} onChange={(e) => setBuyTax(e.target.value)} hint={taxHint.buy ? 'Prefilled from the gate form.' : undefined} />
        <TextInput label="Sell tax (bps)" inputMode="numeric" value={sellTax ?? taxHint.sell ?? '0'} onChange={(e) => setSellTax(e.target.value)} hint={taxHint.sell ? 'Prefilled from the gate form.' : undefined} />
        <TextInput label="Gas, entry (quote units)" inputMode="decimal" value={f.gasIn} onChange={set('gasIn')} />
        <TextInput label="Gas, exit (quote units)" inputMode="decimal" value={f.gasOut} onChange={set('gasOut')} />
        <TextInput label="Failed-tx probability (bps)" inputMode="numeric" value={f.fail} onChange={set('fail')} hint="Expected gas = gas / (1 - p)." />
        <TextInput label="Hypothesised gross move (bps)" inputMode="numeric" value={f.move} onChange={set('move')} hint="Can be negative." />
        <TextInput label="Exit depth (quote units, optional)" inputMode="decimal" value={f.depth} onChange={set('depth')} />
      </div>
      {out.err && <p role="alert" className="mt-4 text-[13px] text-bad">{out.err}</p>}
      {out.r && (
        <div className="mt-5 space-y-3" data-testid="planner-result">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-line p-3"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Break-even gross move</div><div className="tabular text-[20px] font-bold">{out.r.breakEvenGrossBps === null ? 'never' : formatBps(out.r.breakEvenGrossBps)}</div><div className="text-[12px] text-muted">Needed just to pay for costs.</div></div>
            <div className="rounded-xl border border-line p-3"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Total round-trip costs</div><div className="tabular text-[20px] font-bold">{money(out.r.totalCosts)} {f.symbol}</div></div>
            <div className="rounded-xl border border-line p-3"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Net result at hypothesis</div><div className={`tabular text-[20px] font-bold ${out.r.netPnl < 0n ? 'text-bad' : 'text-good'}`}>{money(out.r.netPnl)} {f.symbol}</div><div className="text-[12px] text-muted">{formatBps(out.r.netBpsOfNotional)} of notional</div></div>
          </div>
          <div tabIndex={0} role="region" aria-label="Cost breakdown, scrollable" className="overflow-x-auto rounded-xl border border-line"><table className="w-full min-w-[420px] text-left text-[13px]"><caption className="sr-only">Cost breakdown</caption>
            <thead className="bg-[#f6f8fb] text-[11px] uppercase tracking-wider text-muted"><tr><th scope="col" className="px-4 py-2">Component</th><th scope="col" className="px-4 py-2 text-right">Entry</th><th scope="col" className="px-4 py-2 text-right">Exit</th></tr></thead>
            <tbody>{(['fee', 'slippage', 'tax', 'gas'] as const).map((k) => <tr key={k} className="border-t border-line"><th scope="row" className="px-4 py-2 font-medium capitalize">{k === 'gas' ? 'Gas (expected, incl. failed tx)' : k}</th><td className="tabular px-4 py-2 text-right">{money(out.r!.entryCosts[k])}</td><td className="tabular px-4 py-2 text-right">{money(out.r!.exitCosts[k])}</td></tr>)}</tbody></table></div>
          {out.r.depthWarning && <p role="note" className="rounded-lg bg-warn-soft p-3 text-[13px] text-warn">{out.r.depthWarning}</p>}
          {out.r.positionPctOfExitDepthBps !== null && <p className="text-[12px] text-muted">Position is {formatBps(out.r.positionPctOfExitDepthBps)} of the exit depth you entered.</p>}
          <p className="text-[12px] text-muted">If the sell path fails (honeypot), the loss is the full notional; taxes above 100% make break-even impossible. Costs round up, results round down.</p>
        </div>)}
    </Card>
  );
}
