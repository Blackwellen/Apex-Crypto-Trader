'use client';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, ArrowDown, ArrowUp, Check, Loader2, X } from 'lucide-react';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

export function Card({ title, action, children, className, pad = true }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx('rounded-2xl border border-line bg-card shadow-card', className)}>
      {(title || action) && <header className="flex items-center justify-between gap-3 px-5 pt-4"><h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>{action}</header>}
      <div className={pad ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-[28px] font-bold leading-tight tracking-tight">{title}</h1>{description && <p className="mt-1 max-w-3xl text-[14px] text-muted">{description}</p>}</div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'good' | 'bad' | 'warn';
const tones: Record<Tone, string> = { neutral: 'bg-[#eef1f6] text-[#44546a]', accent: 'bg-accent-soft text-accent', good: 'bg-good-soft text-good', bad: 'bg-bad-soft text-bad', warn: 'bg-warn-soft text-warn' };
export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span title={title} className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide', tones[tone])}>{children}</span>;
}

export function Button({ variant = 'secondary', busy, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean }) {
  const v = { primary: 'bg-accent text-white hover:bg-[#1f48b8]', secondary: 'border border-line bg-white text-ink hover:bg-[#f3f6fb]', danger: 'bg-bad-soft text-bad hover:bg-[#ffe3df] border border-[#f3c9c5]', ghost: 'text-accent hover:bg-accent-soft' }[variant];
  return (
    <button {...p} disabled={p.disabled || busy} className={cx('inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50', v, className)}>
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}{children}
    </button>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-5 shadow-card">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="tabular mt-2 text-[26px] font-bold tracking-tight">{value}</div>
      {sub && <div className={cx('mt-1 text-[12px]', tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-muted')}>{sub}</div>}
    </div>
  );
}

export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cx('animate-pulse rounded-lg bg-[#e9eef5]', className ?? 'h-6 w-full')} />;
export function LoadingBlock({ rows = 3 }: { rows?: number }) { return <div role="status" aria-label="Loading" className="space-y-3">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-9" />)}<span className="sr-only">Loading…</span></div>; }
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-6 py-10 text-center"><p className="font-semibold">{title}</p>{hint && <p className="max-w-md text-[13px] text-muted">{hint}</p>}{action}</div>;
}
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  return <div role="alert" className="flex items-start gap-3 rounded-xl border border-[#f3c9c5] bg-bad-soft p-4 text-bad"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /><div className="text-[13px]"><p className="font-semibold">Could not load this data</p><p>{msg}</p>{retry && <button onClick={retry} className="mt-2 font-semibold underline">Retry</button>}</div></div>;
}
/** Wrap any query result into loading / error / empty / ready states. */
export function Async<T>({ q, children, empty }: { q: { data?: T; isLoading: boolean; error: unknown; refetch?: () => unknown }; children: (d: T) => ReactNode; empty?: (d: T) => boolean }) {
  if (q.isLoading) return <LoadingBlock />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch?.()} />;
  if (q.data === undefined) return null;
  if (empty?.(q.data)) return <EmptyState title="Nothing here yet" />;
  return <>{children(q.data)}</>;
}

// ---------------- Toasts ----------------
const ToastCtx = createContext<{ push: (m: string, tone?: 'good' | 'bad') => void }>({ push: () => {} });
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; m: string; tone: 'good' | 'bad' }[]>([]);
  const push = useCallback((m: string, tone: 'good' | 'bad' = 'good') => { const id = Date.now() + Math.random(); setItems((x) => [...x, { id, m, tone }]); setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 5000); }, []);
  return (
    <ToastCtx.Provider value={useMemo(() => ({ push }), [push])}>
      {children}
      <div aria-live="polite" role="status" className="fixed bottom-4 right-4 z-[60] flex w-[min(92vw,380px)] flex-col gap-2">
        <AnimatePresence>{items.map((t) => (
          <motion.div key={t.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={cx('flex items-start gap-2 rounded-xl border px-4 py-3 text-[13px] shadow-card', t.tone === 'good' ? 'border-[#bfe6d9] bg-good-soft text-good' : 'border-[#f3c9c5] bg-bad-soft text-bad')}>
            {t.tone === 'good' ? <Check className="mt-0.5 size-4" aria-hidden /> : <AlertTriangle className="mt-0.5 size-4" aria-hidden />}<span>{t.m}</span>
          </motion.div>))}</AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------- Dialog / Drawer (native <dialog>: focus trap, Esc, inert background) ----------------
export function Dialog({ open, onClose, title, children, side = false, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; side?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null); const id = useId();
  useEffect(() => { const d = ref.current; if (!d) return; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={id} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={cx('m-0 max-h-[100dvh] w-full bg-transparent p-0 backdrop:bg-[#0f1b33]/40', side ? 'ml-auto h-[100dvh] max-w-[520px]' : 'mx-auto my-auto max-w-[620px] px-3')}>
      {open && (
        <div className={cx('flex flex-col bg-card shadow-2xl', side ? 'h-[100dvh]' : 'max-h-[90dvh] rounded-2xl border border-line')}>
          <div className="flex items-center justify-between border-b border-line px-5 py-4"><h2 id={id} className="text-[16px] font-semibold">{title}</h2>
            <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 hover:bg-[#f0f3f8]"><X className="size-5" /></button></div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </div>)}
    </dialog>
  );
}

/** High-friction confirmation: user must type the phrase. Used for emergency/permission-affecting actions. */
export function ConfirmDialog({ open, onClose, onConfirm, title, body, phrase, busy, confirmLabel = 'Confirm', danger }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; body: ReactNode; phrase?: string; busy?: boolean; confirmLabel?: string; danger?: boolean }) {
  const [t, setT] = useState(''); useEffect(() => { if (!open) setT(''); }, [open]);
  const ok = !phrase || t.trim().toUpperCase() === phrase.toUpperCase();
  return (
    <Dialog open={open} onClose={onClose} title={title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} disabled={!ok} busy={busy} onClick={onConfirm}>{confirmLabel}</Button></>}>
      <div className="space-y-4 text-[14px]">{body}{phrase && <Field label={`Type ${phrase} to confirm`}><input className={inputCls} value={t} onChange={(e) => setT(e.target.value)} autoComplete="off" /></Field>}</div>
    </Dialog>
  );
}

// ---------------- Forms ----------------
export const inputCls = 'min-h-10 w-full rounded-xl border border-line bg-white px-3 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:bg-[#f3f5f9]';
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[12px] font-semibold text-[#44546a]">{label}</span>{children}
    {hint && !error && <span className="mt-1 block text-[12px] text-muted">{hint}</span>}{error && <span role="alert" className="mt-1 block text-[12px] text-bad">{error}</span>}</label>;
}
export function TextInput(p: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = useId(); const { label, hint, error, ...rest } = p;
  return <div><label htmlFor={id} className="mb-1 block text-[12px] font-semibold text-[#44546a]">{label}</label><input id={id} aria-invalid={!!error} aria-describedby={error ? id + 'e' : undefined} {...rest} className={cx(inputCls, rest.className)} />
    {hint && !error && <p className="mt-1 text-[12px] text-muted">{hint}</p>}{error && <p id={id + 'e'} role="alert" className="mt-1 text-[12px] text-bad">{error}</p>}</div>;
}
export function Select(p: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: { value: string; label: string }[]; hint?: string }) {
  const id = useId(); const { label, options, hint, ...rest } = p;
  return <div><label htmlFor={id} className="mb-1 block text-[12px] font-semibold text-[#44546a]">{label}</label><select id={id} {...rest} className={cx(inputCls, rest.className)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>{hint && <p className="mt-1 text-[12px] text-muted">{hint}</p>}</div>;
}

// ---------------- Tabs (WAI-ARIA tabs pattern with arrow-key navigation) ----------------
export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!d) return;
    const n = tabs[(i + d + tabs.length) % tabs.length]; onChange(n.id); refs.current[n.id]?.focus(); e.preventDefault();
  };
  return <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">{tabs.map((t, i) => (
    <button key={t.id} ref={(el) => { refs.current[t.id] = el; }} role="tab" id={`tab-${t.id}`} aria-selected={value === t.id} aria-controls={`panel-${t.id}`} tabIndex={value === t.id ? 0 : -1}
      onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}
      className={cx('whitespace-nowrap border-b-2 px-4 py-2.5 text-[13px] font-semibold', value === t.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-ink')}>{t.label}</button>))}</div>;
}
export const TabPanel = ({ id, value, children }: { id: string; value: string; children: ReactNode }) => value === id ? <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`}>{children}</div> : null;

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return <ol className="mb-5 flex flex-wrap gap-2" aria-label="Progress">{steps.map((s, i) => (
    <li key={s} aria-current={i === current ? 'step' : undefined} className={cx('flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-semibold', i === current ? 'bg-accent text-white' : i < current ? 'bg-good-soft text-good' : 'bg-[#eef1f6] text-muted')}>
      <span>{i < current ? '✓' : i + 1}</span>{s}</li>))}</ol>;
}

// ---------------- DataTable: search / sort / column filter / states ----------------
export interface Col<T> { key: string; header: string; render?: (r: T) => ReactNode; sort?: (r: T) => string | number; text?: (r: T) => string; filter?: boolean; align?: 'right' }
export function DataTable<T extends { id?: string }>({ rows, cols, caption, searchable = true, onRow, empty }: { rows: T[]; cols: Col<T>[]; caption: string; searchable?: boolean; onRow?: (r: T) => void; empty?: ReactNode }) {
  const [q, setQ] = useState(''); const [sort, setSort] = useState<{ k: string; d: 1 | -1 } | null>(null); const [filters, setFilters] = useState<Record<string, string>>({});
  const text = (r: T, c: Col<T>) => (c.text ? c.text(r) : String((r as any)[c.key] ?? ''));
  const filterOpts = useMemo(() => Object.fromEntries(cols.filter((c) => c.filter).map((c) => [c.key, [...new Set(rows.map((r) => text(r, c)))].sort()])), [rows, cols]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    let r = rows.filter((x) => (!q || cols.some((c) => text(x, c).toLowerCase().includes(q.toLowerCase()))) && cols.every((c) => !filters[c.key] || text(x, c) === filters[c.key]));
    if (sort) { const c = cols.find((c) => c.key === sort.k)!; const f = c.sort ?? ((x: T) => text(x, c)); r = [...r].sort((a, b) => (f(a) > f(b) ? 1 : f(a) < f(b) ? -1 : 0) * sort.d); }
    return r;
  }, [rows, q, sort, filters, cols]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {searchable && <input aria-label={`Search ${caption}`} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} className={cx(inputCls, 'max-w-xs')} />}
        {cols.filter((c) => c.filter).map((c) => <select key={c.key} aria-label={`Filter by ${c.header}`} value={filters[c.key] ?? ''} onChange={(e) => setFilters({ ...filters, [c.key]: e.target.value })} className={cx(inputCls, 'w-auto')}>
          <option value="">{c.header}: all</option>{filterOpts[c.key]?.map((o) => <option key={o}>{o}</option>)}</select>)}
        <span className="ml-auto text-[12px] text-muted" aria-live="polite">{shown.length} of {rows.length}</span>
      </div>
      {shown.length === 0 ? (empty ?? <EmptyState title="No matching rows" hint="Adjust your search or filters." />) : (
        <div tabIndex={0} role="region" aria-label={`${caption} (scrollable table)`} className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[560px] text-left text-[13px]"><caption className="sr-only">{caption}</caption>
            <thead className="bg-[#f6f8fb] text-[11px] uppercase tracking-wider text-muted"><tr>{cols.map((c) => (
              <th key={c.key} scope="col" aria-sort={sort?.k === c.key ? (sort.d === 1 ? 'ascending' : 'descending') : 'none'} className={cx('px-4 py-3 font-semibold', c.align === 'right' && 'text-right')}>
                <button className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider" onClick={() => setSort(sort?.k === c.key ? { k: c.key, d: (sort.d * -1) as 1 | -1 } : { k: c.key, d: 1 })}>
                  {c.header}{sort?.k === c.key && (sort.d === 1 ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />)}</button></th>))}</tr></thead>
            <tbody>{shown.map((r, i) => (
              <tr key={r.id ?? i} className={cx('border-t border-line', onRow && 'cursor-pointer hover:bg-[#f9fbfe]')} onClick={() => onRow?.(r)} tabIndex={onRow ? 0 : undefined} onKeyDown={(e) => { if (onRow && e.key === 'Enter') onRow(r); }}>
                {cols.map((c) => <td key={c.key} className={cx('px-4 py-3 align-top', c.align === 'right' && 'tabular text-right')}>{c.render ? c.render(r) : text(r, c)}</td>)}</tr>))}</tbody>
          </table></div>)}
    </div>
  );
}

// ---------------- Charts: accessible, labelled, provenance shown ----------------
export function LineChart({ points, label, unit, provenance, summary }: { points: { x: string; y: number }[]; label: string; unit: string; provenance: string; summary: string }) {
  if (points.length < 2) return <EmptyState title="Not enough data to chart" hint={provenance} />;
  const W = 640, H = 220, P = 36; const ys = points.map((p) => p.y); const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
  const px = (i: number) => P + (i / (points.length - 1)) * (W - P - 8); const py = (v: number) => H - P - ((v - min) / span) * (H - P - 12);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
  return (
    <figure>
      <svg role="img" aria-label={`${label}. ${summary}`} viewBox={`0 0 ${W} ${H}`} className="w-full">
        <title>{label}</title><desc>{summary}</desc>
        {[0, 0.5, 1].map((t) => <g key={t}><line x1={P} x2={W - 8} y1={py(min + span * t)} y2={py(min + span * t)} stroke="#e4e9f0" /><text x={4} y={py(min + span * t) + 4} fontSize="10" fill="#566479">{(min + span * t).toFixed(0)}</text></g>)}
        <path d={d} fill="none" stroke="#2758da" strokeWidth="2" />
        <text x={P} y={H - 8} fontSize="10" fill="#566479">{points[0].x}</text><text x={W - 8} y={H - 8} fontSize="10" textAnchor="end" fill="#566479">{points[points.length - 1].x}</text>
      </svg>
      <figcaption className="mt-1 flex justify-between text-[11px] text-muted"><span>Unit: {unit}</span><span>{provenance}</span></figcaption>
    </figure>
  );
}
export function StackedBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return <div role="img" aria-label={parts.map((p) => `${p.label} ${((p.value / total) * 100).toFixed(1)}%`).join(', ')} className="flex h-2.5 overflow-hidden rounded-full bg-[#eef1f6]">{parts.map((p) => <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />)}</div>;
}
export const Progress = ({ value, tone = 'accent', label = 'Progress' }: { value: number; tone?: 'accent' | 'good' | 'bad'; label?: string }) => <div role="progressbar" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded-full bg-[#eef1f6]"><div className={cx('h-full', tone === 'good' ? 'bg-[#10a37f]' : tone === 'bad' ? 'bg-bad' : 'bg-accent')} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
