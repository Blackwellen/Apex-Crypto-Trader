'use client';
import { useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';

/** Workspace-scoped read: `useWs('buckets')` -> GET v1/buckets?workspace=<id>. Returns the react-query result. */
export function useWs<T = any>(resource: string, extra = '') {
  const { current } = useWorkspace();
  return useApi<T>(current ? `v1/${resource}?workspace=${current.id}${extra}` : null);
}
