'use client';
import { useMemo, useState } from 'react';
import { Badge, DataTable, TextInput } from '@/components/ui';
import { Note } from '@/components/ops/common';
import { formatUnits, parseUnits } from '@/lib/format';
import { simulate, type WaterfallPolicy } from '@/lib/waterfall';

export function Simulator({ policy, symbol, decimals }: { policy: WaterfallPolicy; symbol: string; decimals: number }) {
  const [start, setStart] = useState('1000'); const [ret, setRet] = useState('100'); const [cycles, setCycles] = useState('12');
  const startBase = useMemo(() => { try { return BigInt(parseUnits(start, decimals)); } catch { return null; } }, [start, decimals]);
  const retN = /^\d{1,5}$/.test(ret) ? +ret : null; const cyN = /^\d{1,3}$/.test(cycles) && +cycles >= 1 && +cycles <= 120 ? +cycles : null;
  const rows = useMemo(() => (startBase !== null && retN !== null && cyN !== null ? simulate(startBase, retN, cyN, policy) : []), [startBase, retN, cyN, policy]);
  return (
    <div className="space-y-4" data-testid="simulator">
      <div className="flex flex-wrap items-center gap-2"><Badge tone="warn">Illustrative arithmetic, not a forecast</Badge></div>
      <Note tone="warn">This applies a <strong>fixed return you type in</strong> to every cycle and runs the waterfall on it. It uses no market data, no probabilities and no empirical strategy distribution, so it says nothing about what will happen. Real outcomes include losses, fees and drawdowns.</Note>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextInput label={`Starting tradeable balance (${symbol})`} value={start} onChange={(e) => setStart(e.target.value)} inputMode="decimal" error={startBase === null ? 'Enter a non-negative amount' : undefined} />
        <TextInput label="Assumed return per cycle (bps)" value={ret} onChange={(e) => setRet(e.target.value)} inputMode="numeric" error={retN === null ? '0 to 99999' : undefined} />
        <TextInput label="Cycles (1-120)" value={cycles} onChange={(e) => setCycles(e.target.value)} inputMode="numeric" error={cyN === null ? '1 to 120' : undefined} />
      </div>
      {rows.length > 0 && <DataTable searchable={false} caption="Illustrative compounding arithmetic" rows={rows.map((r) => ({ ...r, id: String(r.cycle) }))} cols={[
        { key: 'cycle', header: 'Cycle', sort: (r) => r.cycle },
        { key: 'profit', header: `Profit (${symbol})`, align: 'right', render: (r) => formatUnits(r.profit, decimals) },
        { key: 'reinvest', header: 'Reinvested', align: 'right', render: (r) => formatUnits(r.reinvest, decimals) },
        { key: 'vault', header: 'To vault', align: 'right', render: (r) => formatUnits(r.vault, decimals) },
        { key: 'tradeable', header: 'Tradeable after', align: 'right', render: (r) => formatUnits(r.tradeable, decimals) },
        { key: 'vaultTotal', header: 'Vault cumulative', align: 'right', render: (r) => formatUnits(r.vaultTotal, decimals) }]} />}
    </div>
  );
}
