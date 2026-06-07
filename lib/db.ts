import { drizzle as drizzlePostgres, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env, usingPglite } from './env';
import * as schema from '../core/schema/tables';

// Dual driver. No DATABASE_URL => in-process PGlite (Postgres 16 + pgvector, no Docker),
// for the local dev/tuning loop. DATABASE_URL set => postgres-js against the real Postgres
// (Supabase in production). The query surface is identical, so /core is driver-agnostic.
export type DB = PostgresJsDatabase<typeof schema>;

const PGLITE_DATA_DIR = '.winnow/pgdata';

// Kept for clean shutdown so the CLI process can exit.
let sqlClient: ReturnType<typeof postgres> | undefined;
let pgliteClient: { close: () => Promise<void> } | undefined;

async function buildPglite(): Promise<DB> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  mkdirSync(dirname(PGLITE_DATA_DIR), { recursive: true }); // PGlite's own mkdir is not recursive
  const client = new PGlite(PGLITE_DATA_DIR);
  pgliteClient = client;
  return drizzle(client, { schema }) as unknown as DB;
}

function buildPostgres(): DB {
  // prepare:false is required for the Supabase transaction pooler; harmless on a direct connection.
  sqlClient = postgres(env.DATABASE_URL as string, { max: 1, prepare: false });
  return drizzlePostgres(sqlClient, { schema });
}

// Top-level await: resolves the correct driver once; importers get a ready, synchronous `db`.
export const db: DB = usingPglite ? await buildPglite() : buildPostgres();

export async function closeDb(): Promise<void> {
  if (sqlClient) await sqlClient.end();
  if (pgliteClient) await pgliteClient.close();
}
