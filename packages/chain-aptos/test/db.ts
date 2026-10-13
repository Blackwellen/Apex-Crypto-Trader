// Fresh-database helper: auth shim + migrations 0001..0119 only (isolates this package's tests from other agents' later migrations).
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Queryable } from '../src/sequence.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:54329/postgres';
export const MIGRATIONS_DIR = path.join(here, '../../db/migrations');
export interface TestDb { url: string; name: string; pool: Queryable & { end(): Promise<void> }; close(): Promise<void> }

export async function freshDb(maxMigration = 119): Promise<TestDb> {
  const name = 'apex_ca_' + Math.random().toString(36).slice(2, 9);
  const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
  await admin.query(`create database ${name}`); await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, '/' + name);
  const psql = (f: string) => execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', f], { stdio: 'pipe' });
  psql(path.join(here, '../../../infra/local/auth_shim.sql'));
  execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', '-c', 'create table if not exists schema_migrations(name text primary key, applied_at timestamptz default now())'], { stdio: 'pipe' });
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) {
    if (Number(f.slice(0, 4)) <= maxMigration) {
      execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', path.join(MIGRATIONS_DIR, f), '-c', `insert into schema_migrations(name) values ('${f}')`], { stdio: 'pipe' });
    }
  }
  const pool = new pg.Pool({ connectionString: url, max: 120 });
  return {
    url, name, pool,
    async close() { await pool.end(); const a = new pg.Client({ connectionString: ADMIN_URL }); await a.connect(); await a.query(`drop database if exists ${name} with (force)`); await a.end(); },
  };
}
