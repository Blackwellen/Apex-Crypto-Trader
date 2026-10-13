// Usage: node --experimental-transform-types scripts/gen-seed-sql.ts   (writes packages/db/migrations/0100_seed_chain_registry.sql)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRegistry, renderSeedSql } from '../src/index.ts';

export const SEED_PATH = fileURLToPath(new URL('../../db/migrations/0100_seed_chain_registry.sql', import.meta.url));
const sql = renderSeedSql(buildRegistry().records);
writeFileSync(SEED_PATH, sql);
console.log(`wrote ${SEED_PATH} (${sql.length} bytes, ${buildRegistry().records.length} chains)`);
