'use client';
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public issues?: { path: string; message: string }[]) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/proxy/${path}`, { ...init, headers: { 'x-apex-csrf': '1', ...(init?.headers ?? {}) } });
  if (r.status === 401 && typeof window !== 'undefined') { window.location.href = '/login'; throw new ApiError(401, 'unauthenticated', 'Signed out'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error ?? 'error', j.message ?? j.error ?? `HTTP ${r.status}`, j.issues);
  return j as T;
}

export const get = <T = any>(path: string) => request<T>(path);

/** React Query read hook. `path` null disables the query. Data is polled lightly; amounts are decimal strings (never JS numbers). */
export function useApi<T = any>(path: string | null, opts?: Partial<UseQueryOptions<T>>) {
  return useQuery<T>({ queryKey: ['api', path], queryFn: () => get<T>(path!), enabled: !!path, refetchInterval: 15_000, staleTime: 5_000, ...(opts as object) });
}

/** Command mutation. Generates a fresh Idempotency-Key per user action (retries of the SAME action reuse it via `key`). */
export function useCommand<B extends object, R = any>(name: string, opts?: { invalidate?: string[] }) {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean; result: R }, ApiError, { body: B; key?: string }>({
    mutationFn: ({ body, key }) => request(`v1/commands/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key ?? crypto.randomUUID() }, body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['api'] }); opts?.invalidate?.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); },
  });
}
