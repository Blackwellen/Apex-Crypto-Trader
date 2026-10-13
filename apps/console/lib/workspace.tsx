'use client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApi } from './api';

export interface WorkspaceRow { id: string; name: string; base_currency: string; role: 'owner' | 'admin' | 'trader' | 'viewer'; global_state: string; paper_running: boolean; live_opt_in: boolean; live_feature_flag: boolean; live_allowed: boolean }
interface Ctx { workspaces: WorkspaceRow[]; current: WorkspaceRow | null; setCurrent: (id: string) => void; loading: boolean; error: Error | null;
  canWrite: boolean; canAdmin: boolean; canOwn: boolean }
const C = createContext<Ctx>({ workspaces: [], current: null, setCurrent: () => {}, loading: true, error: null, canWrite: false, canAdmin: false, canOwn: false });
export const useWorkspace = () => useContext(C);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, error } = useApi<{ items: WorkspaceRow[] }>('v1/workspaces');
  const [id, setId] = useState<string | null>(null);
  useEffect(() => { try { setId(localStorage.getItem('apex.ws')); } catch { /* convenience only */ } }, []);
  const items = data?.items ?? [];
  const current = items.find((w) => w.id === id) ?? items[0] ?? null;
  const value = useMemo<Ctx>(() => ({
    workspaces: items, current, loading: isLoading, error: (error as Error) ?? null,
    setCurrent: (x) => { setId(x); try { localStorage.setItem('apex.ws', x); } catch { /* ignore */ } },
    // UI gating is a convenience only: the database re-checks every role on every command.
    canWrite: !!current && ['owner', 'admin', 'trader'].includes(current.role), canAdmin: !!current && ['owner', 'admin'].includes(current.role), canOwn: current?.role === 'owner',
  }), [items, current, isLoading, error]);
  return <C.Provider value={value}>{children}</C.Provider>;
}
