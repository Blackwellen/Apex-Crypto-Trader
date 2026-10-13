'use client';
import { useCallback, useRef, useState } from 'react';
import { useCommand } from '@/lib/api';
import { Badge, DataTable, useToast } from '@/components/ui';

/** DataTable over loosely-typed API rows. */
export const Table = DataTable<any>;

/**
 * Guarded command runner used by every consequential action in these pages.
 *  - one in-flight call at a time (a second click while pending is ignored),
 *  - one Idempotency-Key per distinct payload, reused for 8s so a mashed double-click or retry can never create a second effect
 *    (the server replays the stored result), a changed payload gets a fresh key,
 *  - the API's rejection message is shown verbatim.
 */
export function useAction<B extends object>(name: string) {
  const cmd = useCommand<B>(name); const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false); const last = useRef<{ sig: string; key: string; t: number } | null>(null);
  const run = useCallback(async (body: B, o?: { ok?: string; onDone?: (r: any) => void }) => {
    if (inflight.current) return undefined;
    inflight.current = true; setError(null);
    const sig = JSON.stringify(body); const now = Date.now();
    if (!last.current || last.current.sig !== sig || now - last.current.t > 8000) last.current = { sig, key: crypto.randomUUID(), t: now };
    else last.current.t = now;
    try {
      const r = await cmd.mutateAsync({ body, key: last.current.key });
      toast.push(o?.ok ?? 'Done'); o?.onDone?.(r.result); return r.result;
    } catch (e) { setError((e as Error).message); toast.push((e as Error).message, 'bad'); return undefined; }
    finally { inflight.current = false; }
  }, [cmd, toast]);
  return { run, busy: cmd.isPending, error };
}

export const EnvBadge = ({ env }: { env: string }) => <Badge tone={env === 'live' ? 'bad' : 'accent'}>{env}</Badge>;
export const Note = ({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warn' | 'bad' }) => (
  <p className={`rounded-xl border p-3 text-[13px] ${tone === 'warn' ? 'border-[#f0dfb7] bg-warn-soft text-warn' : tone === 'bad' ? 'border-[#f3c9c5] bg-bad-soft text-bad' : 'border-line bg-[#f6f8fb] text-[#44546a]'}`}>{children}</p>
);
export const sumBig = (xs: (string | bigint)[]) => xs.reduce<bigint>((a, x) => a + BigInt(x), 0n);
/** Accept only an integer in range from a text field. */
export const intIn = (v: string, lo: number, hi: number): number | null => (/^\d{1,9}$/.test(v.trim()) && +v >= lo && +v <= hi ? +v : null);
