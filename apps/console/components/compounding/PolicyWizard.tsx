'use client';
import { useMemo, useState } from 'react';
import { Button, Dialog, Select, Stepper, TextInput, Badge } from '@/components/ui';
import { Note, useAction } from '@/components/ops/common';
import { useApi } from '@/lib/api';
import { formatUnits, parseUnits } from '@/lib/format';
import { bpsToPct, pctToBps, portionsTotalBps, previewWaterfall, type WaterfallPolicy } from '@/lib/waterfall';
import { transferKind } from '@/lib/transfer';

const STEPS = ['C-01 Basis', 'C-02 Waterfall', 'C-03 Timing', 'C-04 Destinations', 'C-05 Preview & save'];
const MODES = ['proportional', 'fixed', 'target_vol', 'anti_martingale', 'defensive_decompound', 'stair_step'];

export interface BucketLite { id: string; name: string; kind: string; environment: string; state?: string; latest_policy?: any; hwm?: string | null; deficits?: { asset_id: string; symbol: string; decimals: number; amount: string }[] }

export function PolicyWizard({ open, onClose, workspace, bucket, buckets }: { open: boolean; onClose: () => void; workspace: string; bucket: BucketLite; buckets: BucketLite[] }) {
  const cur = bucket.latest_policy;
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<string>(cur?.mode ?? 'proportional');
  const [dd, setDd] = useState(String(cur?.drawdown_limit_bps ?? 1000));
  const [asset, setAsset] = useState('');
  const [minTicket, setMinTicket] = useState('0');
  const [rv, setRv] = useState(cur ? bpsToPct(cur.reinvest_bps) : '100');
  const [vt, setVt] = useState(cur ? bpsToPct(cur.vault_bps) : '0');
  const [cx, setCx] = useState(cur ? bpsToPct(cur.cross_bucket_bps) : '0');
  const [rs, setRs] = useState(cur ? bpsToPct(cur.reserve_bps) : '0');
  const [tax, setTax] = useState(cur ? bpsToPct(cur.tax_provision_bps) : '0');
  const [vaultB, setVaultB] = useState<string>(cur?.vault_bucket_id ?? '');
  const [vaultW, setVaultW] = useState('');
  const [crossB, setCrossB] = useState<string>(cur?.cross_bucket_id ?? '');
  const [crossW, setCrossW] = useState('');
  const [sample, setSample] = useState('100');
  const assets = useApi<{ items: any[] }>('v1/assets');
  const acct = useApi<any>(`v1/capital/accounts?workspace=${workspace}`);
  const save = useAction<any>('applyWaterfallPolicy');

  const bps = { rv: pctToBps(rv), vt: pctToBps(vt), cx: pctToBps(cx), rs: pctToBps(rs), tax: pctToBps(tax) };
  const allParsed = Object.values(bps).every((x) => x !== null);
  const total = allParsed ? portionsTotalBps({ reinvestBps: bps.rv!, vaultBps: bps.vt!, crossBps: bps.cx!, reserveBps: bps.rs! }) : null;
  const totalOk = total === 10000;
  const assetList = assets.data?.items ?? [];
  const asA = assetList.find((a) => a.id === asset) ?? assetList[0];
  const vaultBuckets = buckets.filter((b) => b.kind === 'protected_vault' && b.environment === bucket.environment);
  const crossBuckets = buckets.filter((b) => b.id !== bucket.id && b.kind !== 'protected_vault' && b.kind !== 'gas_reserve' && b.environment === bucket.environment);
  const accountsFor = (bid: string) => (acct.data?.accounts ?? []).filter((a: any) => a.allocations.some((x: any) => x.bucket_id === bid));
  const needVault = (bps.vt ?? 0) > 0, needCross = (bps.cx ?? 0) > 0;
  const destOk = (!needVault || (vaultB && vaultW)) && (!needCross || (crossB && crossW));

  const minBase = useMemo(() => { try { return asA ? BigInt(parseUnits(minTicket || '0', asA.decimals)) : null; } catch { return null; } }, [minTicket, asA]);
  const sampleBase = useMemo(() => { try { return asA ? BigInt(parseUnits(sample || '0', asA.decimals)) : null; } catch { return null; } }, [sample, asA]);
  const policy: WaterfallPolicy | null = allParsed && minBase !== null ? { taxBps: bps.tax!, reinvestBps: bps.rv!, vaultBps: bps.vt!, crossBps: bps.cx!, reserveBps: bps.rs!, minTicket: minBase } : null;
  const ddN = /^\d{1,5}$/.test(dd) && +dd <= 10000 ? +dd : null;
  const def = bucket.deficits?.find((d) => d.asset_id === asA?.id)?.amount ?? '0';
  const prev = policy && sampleBase !== null ? previewWaterfall(sampleBase, BigInt(def), policy) : null;
  const valid = totalOk && destOk && ddN !== null && minBase !== null && !!asA;

  const canNext = [!!asA && ddN !== null && minBase !== null, totalOk && (bps.tax ?? 0) <= 10000, true, !!destOk, valid][step];
  const submit = () => save.run({
    bucket: bucket.id, mode, reinvestBps: bps.rv!, vaultBps: bps.vt!, crossBucketBps: bps.cx!, reserveBps: bps.rs!, taxProvisionBps: bps.tax!,
    ...(needVault ? { vaultBucket: vaultB, vaultWalletChainAccount: vaultW } : {}), ...(needCross ? { crossBucket: crossB, crossWalletChainAccount: crossW } : {}),
    minTicket: minBase!.toString(), drawdownLimitBps: ddN!,
  }, { ok: `Compounding policy v${(cur?.version ?? 0) + 1} saved`, onDone: () => { setStep(0); onClose(); } });

  const fmt = (x: bigint) => asA ? formatUnits(x, asA.decimals) : x.toString();
  const pctInput = (label: string, v: string, set: (s: string) => void, id: string) => (
    <TextInput label={label} value={v} onChange={(e) => set(e.target.value)} inputMode="decimal" data-testid={id} error={pctToBps(v) === null ? 'Enter a percentage with up to 2 decimals' : undefined} />
  );

  return (
    <Dialog open={open} onClose={onClose} title={`Compounding policy: ${bucket.name}`}
      footer={<>
        <Button onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>{step === 0 ? 'Cancel' : 'Back'}</Button>
        {step < 4 ? <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</Button>
          : <Button variant="primary" disabled={!valid} busy={save.busy} onClick={submit}>Save as version {(cur?.version ?? 0) + 1}</Button>}
      </>}>
      <Stepper steps={STEPS} current={step} />
      {step === 0 && <div className="space-y-4">
        <Note>Policies are <strong>immutable versions</strong> (a database trigger forbids updates). Saving creates version {(cur?.version ?? 0) + 1}; the previous version stays on record. Targets and policies are monitoring and accounting rules: they never force a trade.</Note>
        <Select label="Compounding mode" value={mode} onChange={(e) => setMode(e.target.value)} options={MODES.map((m) => ({ value: m, label: m.replace(/_/g, ' ') }))}
          hint="Mode is recorded with the policy. The waterfall below is what the ledger executes after a reconciled profit." />
        <TextInput label="Drawdown limit (basis points)" value={dd} onChange={(e) => setDd(e.target.value)} inputMode="numeric" error={ddN === null ? '0 to 10000' : undefined} hint="Recorded with the policy for defensive decompounding." />
        <Select label="Reporting asset for the minimum ticket and the preview" value={asA?.id ?? ''} onChange={(e) => setAsset(e.target.value)}
          options={assetList.map((a) => ({ value: a.id, label: `${a.symbol} (${a.chain_id})` }))} />
        <TextInput label={`Minimum ticket (${asA?.symbol ?? 'asset'})`} value={minTicket} onChange={(e) => setMinTicket(e.target.value)} inputMode="decimal"
          error={minBase === null ? 'Enter a non-negative amount within the asset precision' : undefined} hint="Profit below this (after deficit recovery) is recorded but not distributed." />
      </div>}
      {step === 1 && <div className="space-y-4">
        <p className="text-[13px] text-muted">Apply to <strong>eligible</strong> net realised profit after the tax provision is taken off the top. The four portions must total exactly 100%.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {pctInput('Reinvest (stays in bucket)', rv, setRv, 'wf-reinvest')}{pctInput('Protected vault sweep', vt, setVt, 'wf-vault')}
          {pctInput('Cross-bucket route', cx, setCx, 'wf-cross')}{pctInput('Fee / gas reserve', rs, setRs, 'wf-reserve')}
        </div>
        <div role="status" aria-live="polite" data-testid="wf-total" className={`flex items-center justify-between rounded-xl border p-3 text-[14px] font-semibold ${totalOk ? 'border-[#bfe6d9] bg-good-soft text-good' : 'border-[#f3c9c5] bg-bad-soft text-bad'}`}>
          <span>Running total</span><span className="tabular">{total === null ? 'invalid input' : `${bpsToPct(total)}%`} {totalOk ? '(exactly 100%)' : '(must be exactly 100.00%)'}</span>
        </div>
        {pctInput('Tax provision (% of eligible, taken first)', tax, setTax, 'wf-tax')}
        <Note>The tax provision is an <strong>accounting set-aside</strong> into a restricted balance. It is not tax advice, not a tax calculation and not a payment.</Note>
      </div>}
      {step === 2 && <div className="space-y-3 text-[14px]">
        <p>How and when the waterfall runs is fixed by the ledger, not by this form:</p>
        <ul className="list-disc space-y-1 pl-5 text-[#44546a]">
          <li>It runs once per profit event, only after the trade is <strong>RECONCILED</strong>; an unreconciled or unsettled profit is rejected.</li>
          <li>Executing twice for the same profit event is impossible (unique constraint): the second call returns the first result.</li>
          <li>A recorded loss creates a <strong>deficit</strong> that is recovered before any profit is distributed. A loss never creates a mandatory win-back target.</li>
          <li>When no net profit exists, nothing is distributed.</li>
        </ul>
        <Note tone="warn">Cool-off periods, schedules and time-zone policy are <strong>not configurable yet</strong> (no scheduler exists). They are intentionally not shown as settings.</Note>
      </div>}
      {step === 3 && <div className="space-y-4">
        {!needVault && !needCross && <p className="text-[14px] text-muted">No vault or cross-bucket portion is set, so no destination is needed.</p>}
        {needVault && <div className="space-y-3 rounded-xl border border-line p-3"><h3 className="text-[13px] font-semibold">Protected vault destination</h3>
          <Select label="Vault bucket" value={vaultB} onChange={(e) => { setVaultB(e.target.value); setVaultW(''); }} options={[{ value: '', label: vaultBuckets.length ? 'Select a vault bucket' : 'No protected vault bucket exists' }, ...vaultBuckets.map((b) => ({ value: b.id, label: b.name }))]} />
          <Select label="Vault wallet / chain account" value={vaultW} onChange={(e) => setVaultW(e.target.value)} disabled={!vaultB}
            options={[{ value: '', label: 'Select an account' }, ...accountsFor(vaultB).map((a: any) => ({ value: a.wca, label: `${a.nickname} on ${a.chain_name}` }))]} /></div>}
        {needCross && <div className="space-y-3 rounded-xl border border-line p-3"><h3 className="text-[13px] font-semibold">Cross-bucket destination</h3>
          <Select label="Destination bucket" value={crossB} onChange={(e) => { setCrossB(e.target.value); setCrossW(''); }} options={[{ value: '', label: 'Select a bucket' }, ...crossBuckets.map((b) => ({ value: b.id, label: b.name }))]} />
          <Select label="Destination wallet / chain account" value={crossW} onChange={(e) => setCrossW(e.target.value)} disabled={!crossB}
            options={[{ value: '', label: 'Select an account' }, ...accountsFor(crossB).map((a: any) => ({ value: a.wca, label: `${a.nickname} on ${a.chain_name}` }))]} /></div>}
        <Note>If a destination wallet differs from the wallet that realised the profit, the sweep is a <strong>PHYSICAL transfer</strong>: it stays pending until finality and the destination budget is not credited early ({transferKind('a', 'b')} vs {transferKind('a', 'a')} is decided by the database from the wallet accounts). Vault funds can later leave only through an approval with a delay and a second owner.</Note>
      </div>}
      {step === 4 && <div className="space-y-4">
        <TextInput label={`Sample realised profit (${asA?.symbol ?? ''}) to preview`} value={sample} onChange={(e) => setSample(e.target.value)} inputMode="decimal" error={sampleBase === null ? 'Enter a non-negative amount' : undefined} />
        <div className="overflow-x-auto rounded-xl border border-line"><table className="w-full min-w-[320px] text-[13px]" data-testid="wf-preview"><caption className="sr-only">Waterfall formula preview</caption>
          <tbody>{prev && ([['Gross realised', prev.gross], ['Deficit recovered first', prev.deficitRecovered], ['Eligible', prev.eligible], ['Tax provision (restricted)', prev.tax], ['Protected vault', prev.vault], ['Cross-bucket', prev.cross], ['Fee / gas reserve', prev.reserve], ['Reinvest (incl. rounding remainder)', prev.reinvest]] as [string, bigint][]).map(([l, v]) => (
            <tr key={l} className="border-t border-line first:border-0"><th scope="row" className="px-4 py-2 text-left font-medium">{l}</th><td className="tabular px-4 py-2 text-right">{fmt(v)} {asA?.symbol}</td></tr>))}</tbody></table></div>
        {prev?.noProfit && <p className="text-[13px] text-muted">No net profit: nothing would be distributed.</p>}
        {prev?.belowMinTicket && <Note tone="warn">Eligible profit is below the minimum ticket: it is recorded but nothing is distributed.</Note>}
        <p className="text-[12px] text-muted">Integer arithmetic identical to the database function: <code>tax = floor(eligible x tax%)</code>, vault/cross/reserve = floor((eligible - tax) x %), reinvest = the remainder. Deficit on this bucket in {asA?.symbol}: {fmt(BigInt(def))}.</p>
        <div className="flex flex-wrap gap-2 text-[12px]"><Badge tone="accent">{bucket.environment}</Badge><Badge>{mode.replace(/_/g, ' ')}</Badge><Badge tone={totalOk ? 'good' : 'bad'}>{total === null ? '-' : bpsToPct(total)}%</Badge></div>
      </div>}
    </Dialog>
  );
}
