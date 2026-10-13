export interface Config {
  databaseUrl: string;
  jwtSecret: string;
  devAuth: boolean;
  devAdminDatabaseUrl: string;   // privileged URL used ONLY by the dev session endpoint to create auth.users rows (GoTrue does this in Supabase)          // local-only token minting; refused when NODE_ENV=production
  corsOrigins: string[];
  rateLimitMax: number;
  port: number;
}
export function loadConfig(env = process.env): Config {
  const prod = env.NODE_ENV === 'production';
  const devAuth = env.APEX_DEV_AUTH === '1';
  if (prod && devAuth) throw new Error('APEX_DEV_AUTH must not be enabled in production');
  const jwtSecret = env.SUPABASE_JWT_SECRET ?? (prod ? '' : 'dev-only-secret-dev-only-secret-0123456789');
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('SUPABASE_JWT_SECRET (>=32 chars) is required');
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://apex_app:apex_app@localhost:54329/apex',
    jwtSecret, devAuth, devAdminDatabaseUrl: env.APEX_DEV_ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:54329/apex',
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
    rateLimitMax: Number(env.RATE_LIMIT_MAX ?? 300),
    port: Number(env.PORT ?? 4000),
  };
}
