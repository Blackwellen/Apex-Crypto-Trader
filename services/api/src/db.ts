import pg from 'pg';
import type { PoolClient } from 'pg';

// bigint-safe: numeric(78,0) arrives as string (pg default) and is never coerced to JS number.
export function makePool(url: string) {
  return new pg.Pool({ connectionString: url, max: 40, idleTimeoutMillis: 30_000 });
}
export type Tx = PoolClient;

/** Run fn inside a transaction as the authenticated end user: role `authenticated` => RLS applies. */
export async function withUser<T>(pool: pg.Pool, userId: string, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await c.query(`set local statement_timeout = '15s'`);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally { c.release(); }
}

/** Maps Postgres errors raised by APEX invariants to safe HTTP errors (no internals leaked). */
export function mapPgError(e: unknown): { status: number; code: string; message: string } | null {
  const err = e as { code?: string; message?: string; constraint?: string };
  if (!err || typeof err.code !== 'string') return null;
  switch (err.code) {
    case '42501': return { status: 403, code: 'forbidden', message: 'permission denied' };
    case '40001': return { status: 409, code: 'stale_version', message: 'policy was changed by someone else; reload and retry' };
    case '23514': return { status: 422, code: 'constraint_violation', message: err.constraint === 'non_negative' ? 'insufficient available balance' : `constraint ${err.constraint ?? ''} violated` };
    case '23505': return { status: 409, code: 'conflict', message: 'duplicate' };
    case '23503': return { status: 422, code: 'bad_reference', message: 'referenced entity does not exist' };
    case 'P0001': return { status: 422, code: 'rejected', message: (err.message ?? 'rejected').replace(/\s+/g, ' ').slice(0, 300) };
    case '57014': return { status: 503, code: 'timeout', message: 'statement timeout' };
    default: return null;
  }
}
