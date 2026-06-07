import { env, usingPglite } from '../lib/env';

// Applies the drizzle-kit generated SQL (./drizzle) to whichever database is configured.
// pgvector is enabled first because stories.embedding is a `vector` column.

async function main(): Promise<void> {
  if (usingPglite) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const { mkdirSync } = await import('node:fs');

    mkdirSync('.winnow', { recursive: true }); // PGlite's own mkdir is not recursive
    const client = new PGlite('.winnow/pgdata');
    await client.waitReady;
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: './drizzle' });
    await client.close();
    console.log('PGlite migrations applied (.winnow/pgdata)');
  } else {
    const postgres = (await import('postgres')).default;
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');

    // Migrations should use the DIRECT connection (:5432), not the pooler.
    const client = postgres((env.DATABASE_DIRECT_URL ?? env.DATABASE_URL) as string, { max: 1 });
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: './drizzle' });
    await client.end();
    console.log('Postgres migrations applied');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
