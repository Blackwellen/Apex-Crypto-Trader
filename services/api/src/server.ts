import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { makePool } from './db.ts';

const cfg = loadConfig();
const app = await buildApp(makePool(cfg.databaseUrl), cfg);
app.listen({ port: cfg.port, host: '127.0.0.1' }).then(() => console.log(`apex-api listening on :${cfg.port} (devAuth=${cfg.devAuth})`));
