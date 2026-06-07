import { createServer, type Server } from 'node:http';
import { log } from '../lib/log';
import { env } from '../lib/env';
import { statusPage } from './pages';

// Tiny localhost server that catches the OAuth redirect (?code&state) during /connect.
// Single-user dev: the bot process runs this so the browser can hand the code back.
const PORT = env.PORT;
const baseUrl = env.PUBLIC_BASE_URL?.replace(/\/$/, '') ?? `http://localhost:${PORT}`;
export const REDIRECT_URL = `${baseUrl}/callback`;

const waiters = new Map<string, (code: string) => void>();
let server: Server | undefined;

export function startCallbackServer(): void {
  if (server) return;
  server = createServer((req, res) => {
    try {
      const u = new URL(req.url ?? '/', REDIRECT_URL);
      if (u.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'winnow' }));
        return;
      }
      if (u.pathname !== '/callback') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state') ?? '';
      const oauthError = u.searchParams.get('error');
      log.info('oauth_callback_hit', { hasCode: Boolean(code), stateMatched: waiters.has(state), oauthError: oauthError ?? null });
      const waiter = code ? waiters.get(state) : undefined;
      if (oauthError) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(statusPage({ title: 'Authorization declined', subtitle: oauthError, tone: 'error' }));
        return;
      }
      if (code && waiter) {
        waiters.delete(state);
        waiter(code);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(statusPage({ title: 'You are connected', subtitle: 'You can close this tab and head back to Telegram. Your next paper will use it.' }));
        return;
      }
      res.writeHead(400);
      res.end('Invalid or expired authorization.');
    } catch (e) {
      res.writeHead(500);
      res.end('error');
      log.warn('oauth_callback_error', { error: (e as Error).message });
    }
  });
  server.on('error', (e) => log.error('oauth_server_error', { error: (e as Error).message }));
  server.listen(PORT, '0.0.0.0', () => log.info('oauth_callback_server_listening', { port: PORT, redirectUrl: REDIRECT_URL }));
}

export function waitForCode(state: string, timeoutMs = 240_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(state);
      reject(new Error('authorization timed out'));
    }, timeoutMs);
    waiters.set(state, (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
