import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../../lib/db';
import { connections, type Connection } from '../schema/tables';
import { addConnection, storeFetched, type SyncResult } from './connections';
import { readFromClient, type McpFetchResult } from './client';
import type { AccountId } from '../schema/domain';

// OAuth for MCP servers that require it (e.g. Creed). Client info, tokens, and the PKCE
// verifier persist in connections.auth so refreshes reuse them. The authorize step is
// surfaced to the caller (the bot sends the user a link); the code comes back via a
// localhost callback the transport layer runs.

interface AuthBlob {
  clientInformation?: unknown;
  tokens?: unknown;
  codeVerifier?: string;
  redirectUrl?: string;
  state?: string;
}

class DbOAuthProvider {
  private capturedUrl?: URL;
  constructor(
    private readonly connectionId: string,
    private readonly _redirectUrl: string,
    private readonly clientName: string,
    private readonly _state: string,
  ) {}

  get redirectUrl(): string {
    return this._redirectUrl;
  }
  get clientMetadata() {
    return {
      client_name: this.clientName,
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state(): string {
    return this._state;
  }

  private async blob(): Promise<AuthBlob> {
    const rows = await db.select({ auth: connections.auth }).from(connections).where(eq(connections.id, this.connectionId)).limit(1);
    return (rows[0]?.auth as AuthBlob) ?? {};
  }
  private async patch(p: Partial<AuthBlob>): Promise<void> {
    const cur = await this.blob();
    await db.update(connections).set({ auth: { ...cur, ...p } }).where(eq(connections.id, this.connectionId));
  }
  async clientInformation(): Promise<unknown> {
    return (await this.blob()).clientInformation;
  }
  async saveClientInformation(info: unknown): Promise<void> {
    await this.patch({ clientInformation: info });
  }
  async tokens(): Promise<unknown> {
    return (await this.blob()).tokens;
  }
  async saveTokens(tokens: unknown): Promise<void> {
    await this.patch({ tokens });
  }
  async saveCodeVerifier(v: string): Promise<void> {
    await this.patch({ codeVerifier: v });
  }
  async codeVerifier(): Promise<string> {
    const v = (await this.blob()).codeVerifier;
    if (!v) throw new Error('missing PKCE code verifier');
    return v;
  }
  redirectToAuthorization(url: URL): void {
    this.capturedUrl = url;
  }
  get captured(): URL | undefined {
    return this.capturedUrl;
  }
}

export interface OAuthConnectHandle {
  status: 'connected' | 'redirect';
  immediate?: SyncResult;
  authorizeUrl?: string;
  state?: string;
  finish?: (code: string) => Promise<SyncResult>;
}

export async function beginOAuthConnect(opts: {
  accountId: AccountId;
  name: string;
  serverUrl: string;
  redirectUrl: string;
}): Promise<OAuthConnectHandle> {
  const conn = await addConnection(opts.accountId, { name: opts.name, url: opts.serverUrl });
  const state = nanoid();
  await db
    .update(connections)
    .set({ auth: { ...((conn.auth as AuthBlob) ?? {}), redirectUrl: opts.redirectUrl, state } })
    .where(eq(connections.id, conn.id));

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const provider = new DbOAuthProvider(conn.id, opts.redirectUrl, 'Winnow', state);
  const transport = new StreamableHTTPClientTransport(new URL(opts.serverUrl), { authProvider: provider as any });
  const client: any = new Client({ name: 'winnow', version: '0.1.0' });

  try {
    await client.connect(transport);
    const r = await readFromClient(client);
    await client.close().catch(() => {});
    const immediate = r.ok ? await storeFetched(conn, r) : { ok: false, name: conn.name, chars: 0, tools: r.toolsCalled, error: r.error };
    return { status: 'connected', immediate };
  } catch (e) {
    const captured = provider.captured;
    if (!captured) throw e;
    const finish = async (code: string): Promise<SyncResult> => {
      await transport.finishAuth(code); // exchanges the code and saves tokens via the provider
      // The original transport is already started; reconnect with a fresh one using stored tokens.
      const t2 = new StreamableHTTPClientTransport(new URL(opts.serverUrl), { authProvider: provider as any });
      const c2: any = new Client({ name: 'winnow', version: '0.1.0' });
      await c2.connect(t2);
      const r = await readFromClient(c2);
      await c2.close().catch(() => {});
      if (!r.ok) return { ok: false, name: conn.name, chars: 0, tools: r.toolsCalled, error: r.error };
      return storeFetched(conn, r);
    };
    return { status: 'redirect', authorizeUrl: captured.toString(), state, finish };
  }
}

/** Read from an already-authorized OAuth connection (refreshes tokens automatically). */
export async function readViaOAuth(c: Connection): Promise<McpFetchResult> {
  const auth = (c.auth as AuthBlob | null) ?? {};
  let client: any;
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const provider = new DbOAuthProvider(c.id, auth.redirectUrl ?? '', 'Winnow', auth.state ?? '');
    const transport = new StreamableHTTPClientTransport(new URL(c.url), { authProvider: provider as any });
    client = new Client({ name: 'winnow', version: '0.1.0' });
    await client.connect(transport);
    const r = await readFromClient(client);
    await client.close().catch(() => {});
    return r;
  } catch (e) {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    return { ok: false, text: '', toolsCalled: [], error: (e as Error).message };
  }
}
