import { log } from '../../lib/log';

// MCP read logic, reusable across bearer-token and OAuth transports. Lists tools, calls the
// read-style ones that need no arguments, and returns their text.

export interface McpFetchResult {
  ok: boolean;
  text: string;
  toolsCalled: string[];
  error?: string;
}

const READ_TOOL = /(read|get|fetch|profile|summary|context|list|recent|me\b)/i;
const RESULT_CAP = 80_000;
const TOOL_PRIORITY = ['read_creed', '_read_creed', 'get_profile', 'read_profile', 'get_context', 'context_summary'];

/** Read context from an already-connected MCP client. */
export async function readFromClient(client: { listTools: () => Promise<unknown>; callTool: (a: unknown) => Promise<unknown> }): Promise<McpFetchResult> {
  const listed = (await client.listTools()) as { tools?: Array<{ name: string; inputSchema?: { required?: string[] } }> };
  const tools = listed?.tools ?? [];
  const readable = tools
    .filter((t) => {
      const required = t.inputSchema?.required;
      const noRequired = !Array.isArray(required) || required.length === 0;
      return noRequired && READ_TOOL.test(t.name ?? '');
    })
    .sort((a, b) => toolPriority(a.name) - toolPriority(b.name))
    .slice(0, 6);

  const parts: string[] = [];
  const called: string[] = [];
  for (const t of readable) {
    try {
      const args = /read_creed/i.test(t.name) ? { agentName: 'Winnow' } : {};
      const r = await client.callTool({ name: t.name, arguments: args });
      const text = extractText(r);
      if (text) {
        parts.push(`## ${t.name}\n${text}`);
        called.push(t.name);
      }
    } catch (e) {
      log.debug('mcp_tool_failed', { tool: t.name, error: (e as Error).message });
    }
  }
  if (parts.length === 0) return { ok: false, text: '', toolsCalled: called, error: 'no readable tools returned content' };
  return { ok: true, text: parts.join('\n\n').slice(0, RESULT_CAP), toolsCalled: called };
}

function toolPriority(name: string): number {
  const normalized = name.toLowerCase();
  const exact = TOOL_PRIORITY.findIndex((candidate) => normalized === candidate);
  if (exact >= 0) return exact;
  if (/creed|profile|context|summary/.test(normalized)) return 20;
  if (/read|get|fetch/.test(normalized)) return 30;
  return 40;
}

/** Fetch from a token-based (bearer) MCP server. */
export async function fetchFromMcp(url: string, token: string | null): Promise<McpFetchResult> {
  let client: any;
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const transport = new StreamableHTTPClientTransport(
      new URL(url),
      token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {},
    );
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

function extractText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim();
}
