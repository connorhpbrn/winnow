import { type Connection } from '../schema/tables';
import { fetchFromMcp } from './client';
import { readViaOAuth } from './oauth';
import { addConnection, listConnections, storeFetched, type SyncResult } from './connections';
import type { AccountId } from '../schema/domain';

export { addConnection, listConnections } from './connections';
export type { SyncResult } from './connections';
export { beginOAuthConnect, type OAuthConnectHandle } from './oauth';

/** Pull fresh context from one connection (OAuth or bearer), replacing its stored snapshot. */
export async function syncConnection(c: Connection): Promise<SyncResult> {
  const auth = c.auth as { tokens?: unknown } | null;
  const fetched = auth?.tokens ? await readViaOAuth(c) : await fetchFromMcp(c.url, c.token);
  if (!fetched.ok) return { ok: false, name: c.name, chars: 0, tools: fetched.toolsCalled, error: fetched.error };
  return storeFetched(c, fetched);
}

/** Add (or update) a token-based connection and pull its context immediately. */
export async function connectMcp(
  accountId: AccountId,
  c: { name: string; url: string; token?: string | null },
): Promise<SyncResult> {
  const conn = await addConnection(accountId, c);
  return syncConnection(conn);
}

/** Refresh every enabled connection (called before a brief / on demand). */
export async function syncAllConnections(accountId: AccountId): Promise<SyncResult[]> {
  const conns = await listConnections(accountId);
  const out: SyncResult[] = [];
  for (const c of conns) {
    if (!c.enabled) continue;
    try {
      out.push(await syncConnection(c));
    } catch (e) {
      out.push({ ok: false, name: c.name, chars: 0, tools: [], error: (e as Error).message });
    }
  }
  return out;
}
