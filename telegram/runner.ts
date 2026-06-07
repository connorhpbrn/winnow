import { requireTelegramToken } from '../lib/env';
import { closeDb } from '../lib/db';
import { log } from '../lib/log';
import { TelegramClient } from './client';
import { handleUpdate } from './router';
import { startCallbackServer } from './oauth-server';

// Dev runner: long-polling (no public URL / webhook needed). Live while this process runs.
const COMMANDS = [
  { command: 'start', description: 'Set up your profile' },
  { command: 'paper', description: 'Generate your latest paper' },
  { command: 'profile', description: 'What Winnow understands about you' },
  { command: 'connect', description: 'Connect a tool like Creed' },
  { command: 'reset', description: 'Wipe everything and start over' },
  { command: 'feedback', description: 'Send the team a note' },
  { command: 'help', description: 'What Winnow can do' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const client = new TelegramClient(requireTelegramToken());
  startCallbackServer(); // localhost OAuth callback (for /connect)
  const me = await client.getMe();
  await client.setMyCommands(COMMANDS);
  console.log(`Winnow dev bot live as @${me.username}. Long-polling, Ctrl+C to stop.`);

  let offset = 0;
  let running = true;
  // Exit promptly on signal so restarts do not leave a stale process holding port 8765.
  const stop = () => {
    running = false;
    closeDb()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (running) {
    try {
      const updates = await client.getUpdates(offset, 25);
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(client, u);
      }
    } catch (e) {
      log.error('poll_error', { error: (e as Error).message });
      await sleep(2000);
    }
  }

  await closeDb();
  console.log('Bot stopped.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
