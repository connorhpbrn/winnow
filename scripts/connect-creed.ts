import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db, closeDb } from '../lib/db';
import { accounts, connections } from '../core/schema/tables';
import { beginOAuthConnect } from '../core/mcp/oauth';
import { statusPage } from '../telegram/pages';

// One-off: connect a user's account to Creed via OAuth, opening the authorize page in the
// Mac browser and catching the redirect locally. Run with the bot stopped (single-process DB).
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;

async function resolveAccountId(): Promise<string> {
  const tg = await db.select({ id: accounts.id }).from(accounts).where(isNotNull(accounts.telegramUserId)).orderBy(desc(accounts.createdAt)).limit(1);
  if (tg[0]) return tg[0].id;
  return readFileSync('.winnow/dev-account.txt', 'utf8').trim();
}

async function main(): Promise<void> {
  const accountId = await resolveAccountId();
  console.log('TARGET_ACCOUNT', accountId);

  // Clean any prior half-registered creed connection so we register fresh for this redirect.
  await db.delete(connections).where(and(eq(connections.accountId, accountId), eq(connections.name, 'creed')));

  const handle = await beginOAuthConnect({ accountId, name: 'creed', serverUrl: 'https://creed.md/mcp', redirectUrl: REDIRECT });
  if (handle.status === 'connected') {
    console.log('RESULT', JSON.stringify(handle.immediate));
    await closeDb();
    return;
  }

  const codePromise = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', REDIRECT);
      if (u.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      if (err) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(statusPage({ title: 'Authorization declined', subtitle: err, tone: 'error' }));
        server.close();
        reject(new Error(`declined: ${err}`));
        return;
      }
      if (code) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(statusPage({ title: 'Creed connected', subtitle: 'You can close this tab. Your next paper will use it.' }));
        server.close();
        resolve(code);
        return;
      }
      res.writeHead(400);
      res.end('no code');
    });
    server.listen(PORT, () => console.log('CALLBACK_LISTENING', PORT));
    setTimeout(() => {
      server.close();
      reject(new Error('timed out waiting for authorization'));
    }, 300_000);
  });

  console.log('AUTHORIZE_URL', handle.authorizeUrl);
  try {
    execFileSync('open', [handle.authorizeUrl!]);
    console.log('OPENED_IN_BROWSER');
  } catch {
    console.log('COULD_NOT_OPEN_open_the_url_above_manually');
  }

  const code = await codePromise;
  console.log('GOT_CODE');
  const result = await handle.finish!(code);
  console.log('RESULT', JSON.stringify(result));
  await closeDb();
}

main().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
