import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` only needs schema + out + dialect.
// `drizzle-kit migrate` (hosted Postgres path) reads DATABASE_URL (use the DIRECT :5432 connection).
// The local PGlite dev path applies the same generated SQL via scripts/migrate.ts.
export default defineConfig({
  schema: './core/schema/tables.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/winnow',
  },
  verbose: true,
  strict: true,
});
