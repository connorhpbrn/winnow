import { and, eq } from 'drizzle-orm';
import { db } from '../../lib/db';
import { connections, contextItems, type Connection } from '../schema/tables';
import { addContext } from '../memory/context';
import type { AccountId } from '../schema/domain';

export interface SyncResult {
  ok: boolean;
  name: string;
  chars: number;
  tools: string[];
  error?: string;
}

// Per-user MCP connections. Upsert by (account, name).
export async function addConnection(
  accountId: AccountId,
  c: { name: string; url: string; token?: string | null; kind?: string },
): Promise<Connection> {
  const existing = await db
    .select()
    .from(connections)
    .where(and(eq(connections.accountId, accountId), eq(connections.name, c.name)))
    .limit(1);
  if (existing[0]) {
    const updated = await db
      .update(connections)
      .set({ url: c.url, ...(c.token !== undefined ? { token: c.token } : {}), enabled: true })
      .where(eq(connections.id, existing[0].id))
      .returning();
    return updated[0]!;
  }
  const inserted = await db
    .insert(connections)
    .values({ accountId, kind: c.kind ?? 'mcp', name: c.name, url: c.url, token: c.token ?? null })
    .returning();
  return inserted[0]!;
}

export async function listConnections(accountId: AccountId): Promise<Connection[]> {
  return db.select().from(connections).where(eq(connections.accountId, accountId));
}

/** Replace this connection's snapshot in the context store with freshly fetched text. */
export async function storeFetched(c: Connection, fetched: { text: string; toolsCalled: string[] }): Promise<SyncResult> {
  const source = `mcp:${c.name}`;
  await db.delete(contextItems).where(and(eq(contextItems.accountId, c.accountId), eq(contextItems.source, source)));
  await addContext(c.accountId, { source, label: c.name, content: fetched.text });
  await db.update(connections).set({ lastSyncedAt: new Date() }).where(eq(connections.id, c.id));
  return { ok: true, name: c.name, chars: fetched.text.length, tools: fetched.toolsCalled };
}
