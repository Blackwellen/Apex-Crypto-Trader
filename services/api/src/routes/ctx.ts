import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { z } from 'zod';
import type { Config } from '../config.ts';
import type { Tx } from '../db.ts';

/** Everything a feature route module needs. Reads run as the authenticated user inside a transaction (RLS applies). */
export interface RouteCtx {
  app: FastifyInstance; pool: pg.Pool; cfg: Config;
  read: <R>(req: FastifyRequest, fn: (c: Tx) => Promise<R>) => Promise<R>;
  /** register POST /v1/commands/<name>: validates body (zod), requires Idempotency-Key, rejects secret-looking fields, runs as the user in one transaction */
  cmd: <S extends z.ZodTypeAny>(name: string, schema: S, run: (c: Tx, b: z.infer<S>, key: string, userId: string) => Promise<unknown>) => void;
  one: (c: Tx, sql: string, p: unknown[]) => Promise<any>;
  q: <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest) => z.infer<T>;
  schemas: { uuid: z.ZodString; amount: z.ZodString; ws: z.ZodObject<{ workspace: z.ZodString }>; page: z.ZodTypeAny };
}
export type RouteModule = (ctx: RouteCtx) => void | Promise<void>;
