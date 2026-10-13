'use client';
import { useState } from 'react';
import { Badge, Button, Card, Select, TextInput, useToast } from '@/components/ui';
import { useCommand, ApiError } from '@/lib/api';
import { useResearcher } from '@/components/research/common';
import { useMutation } from '@tanstack/react-query';

type Tri = '' | 'yes' | 'no';
export interface GateForm { family: 'evm' | 'solana'; bools: Record<string, Tri>; nums: Record<string, string>; strategy: string; position: string; edge: string; slippage: string; vendorName: string; vendorScore: string }
export const emptyGateForm = (family: 'evm' | 'solana'): GateForm => ({ family, bools: {}, nums: {}, strategy: 'default', position: '1000', edge: '300', slippage: '30', vendorName: '', vendorScore: '' });

const BOOLS: { k: string; label: string; fam: 'evm' | 'solana' | 'both'; group: string }[] = [
  { k: 'sell_simulation_ok', label: 'Representative SELL simulation succeeded', fam: 'both', group: 'Sell path' },
  { k: 'owner_can_mint', label: 'Owner/privileged account can mint', fam: 'evm', group: 'EVM controls' }, { k: 'is_upgradeable_proxy', label: 'Upgradeable proxy', fam: 'evm', group: 'EVM controls' },
  { k: 'ownership_renounced', label: 'Ownership renounced', fam: 'evm', group: 'EVM controls' }, { k: 'can_pause_transfers', label: 'Transfers can be paused', fam: 'evm', group: 'EVM controls' },
  { k: 'has_blacklist', label: 'Blacklist / sell restriction function', fam: 'evm', group: 'EVM controls' }, { k: 'can_change_tax', label: 'Tax rate can be changed', fam: 'evm', group: 'EVM controls' },
  { k: 'mint_authority_set', label: 'Mint authority still set', fam: 'solana', group: 'Solana controls' }, { k: 'freeze_authority_set', label: 'Freeze authority still set', fam: 'solana', group: 'Solana controls' },
  { k: 'permanent_delegate_set', label: 'Token-2022 permanent delegate set', fam: 'solana', group: 'Solana controls' }, { k: 'transfer_hook_set', label: 'Token-2022 transfer hook set', fam: 'solana', group: 'Solana controls' },
  { k: 'lp_lock_verified', label: 'LP lock verified on-chain by you', fam: 'both', group: 'Liquidity' }, { k: 'lp_controlled_by_deployer', label: 'LP controlled by deployer / unlocked', fam: 'both', group: 'Liquidity' },
];
const NUMS: { k: string; label: string; unit: string; fam: 'evm' | 'solana' | 'both'; group: string; max: number }[] = [
  { k: 'sell_simulation_slippage_bps', label: 'Simulated sell slippage', unit: 'bps', fam: 'both', group: 'Sell path', max: 100000 }, { k: 'buy_tax_bps', label: 'Buy tax', unit: 'bps', fam: 'both', group: 'Sell path', max: 10000 },
  { k: 'sell_tax_bps', label: 'Sell tax', unit: 'bps', fam: 'both', group: 'Sell path', max: 10000 }, { k: 'transfer_fee_bps', label: 'Token-2022 transfer fee', unit: 'bps', fam: 'solana', group: 'Solana controls', max: 10000 },
  { k: 'liquidity_usd', label: 'Headline liquidity', unit: 'USD', fam: 'both', group: 'Liquidity', max: 1e12 }, { k: 'exit_depth_usd', label: 'Effective exit depth at your size', unit: 'USD', fam: 'both', group: 'Liquidity', max: 1e12 },
  { k: 'lp_locked_pct', label: 'LP locked (claimed)', unit: '%', fam: 'both', group: 'Liquidity', max: 100 }, { k: 'lp_lock_remaining_days', label: 'Verified lock remaining', unit: 'days', fam: 'both', group: 'Liquidity', max: 36500 },
  { k: 'top1_holder_pct', label: 'Top holder (excl. burn/LP/CEX)', unit: '%', fam: 'both', group: 'Holders', max: 100 }, { k: 'top10_holder_pct', label: 'Top-10 holders', unit: '%', fam: 'both', group: 'Holders', max: 100 },
  { k: 'deployer_holder_pct', label: 'Deployer holds', unit: '%', fam: 'both', group: 'Holders', max: 100 }, { k: 'sybil_cluster_pct', label: 'Commonly-funded wallet cluster', unit: '%', fam: 'both', group: 'Holders', max: 100 },
  { k: 'deployer_prior_rugs', label: 'Deployer prior rugs', unit: 'count', fam: 'both', group: 'History', max: 10000 },
];
const parse = (s: string): number | null | undefined => (s.trim() === '' ? null : Number.isFinite(Number(s)) ? Number(s) : undefined);

export function buildGateBody(f: GateForm): { body?: any; errors: string[] } {
  const errors: string[] = [];
  const findings: Record<string, unknown> = { chain_family: f.family };
  for (const b of BOOLS) if (b.fam === 'both' || b.fam === f.family) { const t = f.bools[b.k] ?? ''; findings[b.k] = t === 'yes' ? true : t === 'no' ? false : null; }
  for (const n of NUMS) if (n.fam === 'both' || n.fam === f.family) {
    const v = parse(f.nums[n.k] ?? ''); if (v === undefined) { errors.push(`${n.label} is not a number`); continue; }
    if (v !== null && (v < 0 || v > n.max)) errors.push(`${n.label} must be between 0 and ${n.max}`);
    findings[n.k] = v !== null && n.k === 'deployer_prior_rugs' ? Math.trunc(v) : v;
  }
  const age = parse(f.nums.age_hours ?? ''); if (age === null || age === undefined || age < 0) errors.push('Token age (hours) is required');
  findings.age_hours = age ?? 0; findings.findings_age_seconds = Math.max(0, parse(f.nums.findings_age_seconds ?? '') ?? 0);
  if (f.vendorName.trim()) { const sc = parse(f.vendorScore); if (sc === undefined || (sc !== null && (sc < 0 || sc > 100))) errors.push('Vendor score must be 0 to 100'); findings.vendors = [{ vendor: f.vendorName.trim(), risk_score: sc ?? null, age_seconds: 0, flags: [] }]; }
  const position = parse(f.position), edge = parse(f.edge), slip = parse(f.slippage);
  if (position === null || position === undefined || position < 0) errors.push('Position size (USD) is required'); if (edge === null || edge === undefined) errors.push('Expected gross edge (bps) is required'); if (slip === null || slip === undefined || slip < 0) errors.push('Estimated slippage (bps) is required');
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(f.strategy)) errors.push('Strategy key must be lowercase letters, digits, underscore');
  return errors.length ? { errors } : { errors, body: { strategy: f.strategy, positionUsd: position, expectedGrossEdgeBps: edge, estSlippageBps: slip, findings } };
}

export interface GateResult { stage1_passed: boolean; vetoes: { code: string; severity: string; detail: string }[]; warnings: { code: string; detail: string }[]; score_informational: number; confidence: number; vendor_notes: string[]; admitted_by_strategy: boolean; admission_reasons: string[]; inputNote: string }

export function SecurityGate({ form, setForm, result, setResult }: { form: GateForm; setForm: (f: GateForm) => void; result: GateResult | null; setResult: (r: GateResult | null) => void }) {
  const toast = useToast(); const r = useResearcher(); const reachable = !!r.data?.reachable;
  const evalM = useMutation<GateResult, ApiError, any>({ mutationFn: async (body) => { const res = await fetch('/api/proxy/v1/research/token-safety/evaluate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-apex-csrf': '1' }, body: JSON.stringify(body) }); const j = await res.json().catch(() => ({})); if (!res.ok) throw new ApiError(res.status, j.error ?? 'error', j.message ?? `HTTP ${res.status}`); return j; } });
  const built = buildGateBody(form);
  const setB = (k: string, v: Tri) => { setForm({ ...form, bools: { ...form.bools, [k]: v } }); setResult(null); };
  const setN = (k: string, v: string) => { setForm({ ...form, nums: { ...form.nums, [k]: v } }); setResult(null); };
  const groups = [...new Set([...BOOLS, ...NUMS].filter((x) => x.fam === 'both' || x.fam === form.family).map((x) => x.group))];
  return (
    <Card title="Universal security gate">
      <p className="mb-4 text-[13px] text-muted">Enter the structured findings you have verified (simulation results, contract reads, holder data). The researcher&apos;s deterministic scorer applies hard vetoes first: <strong>any veto rejects, whatever the score</strong>, and blank fields count as <strong>unknown, which fails closed</strong>. Vendor scores (GoPlus, RugCheck, DEX Screener…) are additive evidence only and can never clear a token. APEX does not read the chain for you here.</p>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select label="Chain family" value={form.family} onChange={(e) => { setForm({ ...form, family: e.target.value as 'evm' | 'solana' }); setResult(null); }} options={[{ value: 'evm', label: 'EVM' }, { value: 'solana', label: 'Solana / Token-2022' }]} />
        <TextInput label="Token age (hours)" type="number" min={0} step="any" value={form.nums.age_hours ?? ''} onChange={(e) => setN('age_hours', e.target.value)} />
        <TextInput label="Findings age (seconds)" type="number" min={0} step="any" value={form.nums.findings_age_seconds ?? ''} onChange={(e) => setN('findings_age_seconds', e.target.value)} hint="Stale findings (>15 min) veto." />
        <TextInput label="Strategy key" value={form.strategy} onChange={(e) => { setForm({ ...form, strategy: e.target.value }); setResult(null); }} />
      </div>
      {groups.map((g) => (
        <fieldset key={g} className="mb-4"><legend className="mb-2 text-[12px] font-bold uppercase tracking-wider text-muted">{g}</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {BOOLS.filter((b) => b.group === g && (b.fam === 'both' || b.fam === form.family)).map((b) => <Select key={b.k} label={b.label} value={form.bools[b.k] ?? ''} onChange={(e) => setB(b.k, e.target.value as Tri)} options={[{ value: '', label: 'Unknown (fails closed)' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />)}
            {NUMS.filter((n) => n.group === g && (n.fam === 'both' || n.fam === form.family)).map((n) => <TextInput key={n.k} label={`${n.label} (${n.unit})`} type="number" min={0} max={n.max} step="any" value={form.nums[n.k] ?? ''} onChange={(e) => setN(n.k, e.target.value)} placeholder="unknown" />)}
          </div></fieldset>))}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <TextInput label="Position size (USD)" type="number" min={0} step="any" value={form.position} onChange={(e) => { setForm({ ...form, position: e.target.value }); setResult(null); }} />
        <TextInput label="Expected gross edge (bps)" type="number" step="any" value={form.edge} onChange={(e) => { setForm({ ...form, edge: e.target.value }); setResult(null); }} hint="Your hypothesis, not a forecast." />
        <TextInput label="Estimated slippage (bps, one way)" type="number" min={0} step="any" value={form.slippage} onChange={(e) => { setForm({ ...form, slippage: e.target.value }); setResult(null); }} />
        <TextInput label="Vendor name (optional)" value={form.vendorName} onChange={(e) => { setForm({ ...form, vendorName: e.target.value }); setResult(null); }} />
        <TextInput label="Vendor risk score 0-100" type="number" min={0} max={100} value={form.vendorScore} onChange={(e) => { setForm({ ...form, vendorScore: e.target.value }); setResult(null); }} hint="Additive evidence only." />
      </div>
      {built.errors.length > 0 && <ul role="alert" className="mb-3 list-disc pl-5 text-[13px] text-bad">{built.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {!reachable && <p role="alert" className="mb-3 text-[13px] font-semibold text-bad">Researcher NOT REACHABLE: no safety evaluation can be produced. Treat the token as NOT cleared.</p>}
      <Button variant="primary" disabled={!reachable || built.errors.length > 0} busy={evalM.isPending} onClick={() => evalM.mutate(built.body, { onSuccess: (d) => setResult(d), onError: (e) => { setResult(null); toast.push(e.message, 'bad'); } })}>Run security gate</Button>
      {result && <GateVerdict r={result} />}
    </Card>
  );
}

export function GateVerdict({ r }: { r: GateResult }) {
  return (
    <div className="mt-5 space-y-3" aria-live="polite" data-testid="gate-result">
      <div className={`rounded-xl border p-4 ${r.stage1_passed ? 'border-[#bfe6d9] bg-good-soft text-good' : 'border-[#f3c9c5] bg-bad-soft text-bad'}`}>
        <div className="text-[15px] font-bold">{r.stage1_passed ? 'Stage 1 PASSED: no hard veto' : 'Stage 1 REJECTED'}</div>
        <p className="text-[13px]">{r.stage1_passed ? 'Passing the gate only makes this token eligible for strategy admission. It is not a recommendation.' : 'Why rejected is listed below. A score cannot override a veto.'}</p>
      </div>
      {r.vetoes.length > 0 && <div><h3 className="mb-1 text-[12px] font-bold uppercase tracking-wider text-muted">Vetoes (why rejected)</h3>
        <ul className="space-y-1 text-[13px]">{r.vetoes.map((v) => <li key={v.code + v.detail} className="rounded-lg bg-bad-soft px-3 py-2 text-bad"><code className="font-bold">{v.code}</code>: {v.detail}</li>)}</ul></div>}
      {r.warnings.length > 0 && <div><h3 className="mb-1 text-[12px] font-bold uppercase tracking-wider text-muted">Warnings</h3>
        <ul className="space-y-1 text-[13px]">{r.warnings.map((v) => <li key={v.code + v.detail} className="rounded-lg bg-warn-soft px-3 py-2 text-warn"><code className="font-bold">{v.code}</code>: {v.detail}</li>)}</ul></div>}
      <div className="grid gap-3 text-[13px] sm:grid-cols-3">
        <div><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Informational score</div><div className="tabular text-[18px] font-bold">{r.score_informational}</div><div className="text-muted">Not a decision; vetoes decide.</div></div>
        <div><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Confidence</div><div className="tabular text-[18px] font-bold">{Math.round(r.confidence * 100)}%</div><div className="text-muted">Share of critical fields actually known.</div></div>
        <div><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Strategy admission</div><div><Badge tone={r.admitted_by_strategy ? 'good' : 'bad'}>{r.admitted_by_strategy ? 'Admitted' : 'Not admitted'}</Badge></div></div>
      </div>
      {r.admission_reasons.length > 0 && <ul className="list-disc pl-5 text-[13px] text-bad">{r.admission_reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
      {r.vendor_notes.length > 0 && <div><h3 className="mb-1 text-[12px] font-bold uppercase tracking-wider text-muted">Vendor evidence (additive only)</h3><ul className="list-disc pl-5 text-[13px] text-muted">{r.vendor_notes.map((x) => <li key={x}>{x}</li>)}</ul></div>}
      <p className="text-[12px] text-muted">{r.inputNote}</p>
    </div>
  );
}
