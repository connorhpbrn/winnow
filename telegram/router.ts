import { eq } from 'drizzle-orm';
import { db } from '../lib/db';
import { usageDaily, generationLocks } from '../core/schema/tables';
import { hasOpenRouterKey } from '../lib/env';
import { log } from '../lib/log';
import { transcribeAudio } from '../core/models/transcribe';
import { handleUserMessage, handleDeepDive, handleItemAction, generateBrief } from '../core/agent';
import { getProfile, getInterests } from '../core/memory/profile';
import { addContext, contextSummary } from '../core/memory/context';
import { recordBriefFeedback } from '../core/memory/feedback';
import { connectMcp, syncAllConnections, listConnections, beginOAuthConnect } from '../core/mcp';
import { REDIRECT_URL, waitForCode } from './oauth-server';
import { renderEditionHtml } from '../lib/edition';
import type { TelegramClient, TgUpdate, TgCallbackQuery } from './client';
import { getOrCreateAccountByTelegram, getState, resetAccountData } from './store';
import { startOnboarding, advanceOnboarding, isOnboarding, ingestOnboardingFile } from './onboarding';
import {
  paperPreviewHtml,
  paperPreviewRich,
  paperFeedbackKeyboard,
  replyToHtml,
  esc,
} from './format';

interface Account {
  id: string;
  onboardedAt: Date | null;
}

const HELP = [
  '<b>Winnow</b> watches your sources and briefs you only on what matters to you.',
  '',
  '/start - set up your profile',
  '/paper - generate your latest paper',
  '/profile - what I understand about you',
  '/connect - connect a tool, e.g. /connect creed',
  '/reset - wipe everything and start over',
  '/feedback - send the team a note',
  '/help - this message',
  '',
  'The more I know, the sharper your papers: send me files, forward me anything, or tell me what to remember.',
].join('\n');

export async function handleUpdate(client: TelegramClient, update: TgUpdate): Promise<void> {
  if (update.callback_query) return handleCallback(client, update.callback_query);

  const msg = update.message;
  if (!msg?.from) return;
  const chatId = msg.chat.id;

  try {
    const account = await getOrCreateAccountByTelegram(msg.from.id, chatId);

    if (msg.voice) {
      if (msg.voice.duration > 10 * 60 || (msg.voice.file_size ?? 0) > 20_000_000) {
        await client.sendMessage(chatId, 'That voice note is too long. Keep voice notes under 10 minutes.');
        return;
      }
      await client.sendChatAction(chatId, 'typing');
      const audio = await client.getFileBlob(msg.voice.file_id);
      if (!audio) {
        await client.sendMessage(chatId, 'I could not download that voice note. Try sending it again.');
        return;
      }
      let transcript: string;
      try {
        transcript = await transcribeAudio(audio, 'voice.ogg');
      } catch {
        await client.sendMessage(chatId, 'I could not transcribe that clearly. Try again or send it as text.');
        return;
      }
      await handleText(client, chatId, account, transcript);
      return;
    }

    // A file sent at ANY point during onboarding becomes extra context. Post-onboarding,
    // it is appended to the profile for the next rebuild.
    if (msg.document) {
      const label = msg.document.file_name ?? 'document';
      const fileText = await client.getFileText(msg.document.file_id);
      if (!fileText) {
        await client.sendMessage(chatId, 'I could not read that as text. I can read txt, md, csv, or json. Paste the key parts instead.');
      } else if (await isOnboarding(account.id)) {
        await client.sendMessage(chatId, esc(await ingestOnboardingFile(account.id, label, fileText)));
      } else if (account.onboardedAt) {
        await addContext(account.id, { source: 'file', label, content: fileText });
        await client.sendMessage(chatId, `Added ${esc(label)} to your context. It will sharpen your next paper.`);
      } else {
        await client.sendMessage(chatId, 'Send /start first, then you can share files as you set up.');
      }
      return;
    }

    // A forwarded message is the easiest context capture: just remember it.
    if ((msg.forward_date != null || msg.forward_origin != null) && msg.text) {
      if (await isOnboarding(account.id)) {
        await client.sendMessage(chatId, esc(await ingestOnboardingFile(account.id, 'forwarded note', msg.text)));
      } else {
        await addContext(account.id, { source: 'forward', label: 'forwarded', content: msg.text });
        await client.sendMessage(chatId, 'Saved that to your context.');
      }
      return;
    }

    const text = msg.text?.trim();
    if (!text) return;
    await handleText(client, chatId, account, text);
  } catch (e) {
    log.error('handle_update_failed', { error: (e as Error).message });
    await client.sendMessage(chatId, 'I hit a snag handling that. Try again in a moment.').catch(() => {});
  }
}

async function handleText(client: TelegramClient, chatId: number, account: Account, text: string): Promise<void> {
    if (text.startsWith('/')) {
      await handleCommand(client, chatId, account, text);
      return;
    }

    const state = await getState(account.id);
    if (state.currentFlow === 'onboarding') {
      const res = await advanceOnboarding(account.id, text);
      await client.sendMessage(chatId, esc(res.reply));
      if (res.generateNow) await sendBrief(client, chatId, account.id, { reset: false });
      return;
    }

    if (!account.onboardedAt) {
      await client.sendMessage(chatId, 'Send /start and I will set you up.');
      return;
    }

    await client.sendChatAction(chatId);
    const reply = await handleUserMessage({ accountId: account.id, text });
    await client.sendMessage(chatId, replyToHtml(reply));
    await runEffects(client, chatId, account.id, reply.effects);
}

async function handleCallback(client: TelegramClient, cb: TgCallbackQuery): Promise<void> {
  const chatId = cb.message?.chat.id ?? cb.from.id;
  const briefFeedback = /^(bg|bb):(.+)$/.exec(cb.data ?? '');
  if (briefFeedback) {
    const account = await getOrCreateAccountByTelegram(cb.from.id, chatId);
    const rating = briefFeedback[1] === 'bg' ? 'good' : 'bad';
    await recordBriefFeedback(account.id, briefFeedback[2]!, rating);
    await client.answerCallbackQuery(cb.id, rating === 'good' ? 'Noted. More like this.' : 'Noted. I will adjust the next paper.');
    return;
  }
  await client.answerCallbackQuery(cb.id);
  const m = /^([mds]):(.+)$/.exec(cb.data ?? '');
  if (!m) return;
  try {
    const account = await getOrCreateAccountByTelegram(cb.from.id, chatId);
    const action = m[1] === 'd' ? 'deep' : m[1] === 's' ? 'sources' : 'more';
    await client.sendChatAction(chatId);
    const reply = await handleItemAction(account.id, action, m[2]!);
    await client.sendMessage(chatId, replyToHtml(reply));
  } catch (e) {
    log.error('handle_callback_failed', { error: (e as Error).message });
    await client.sendMessage(chatId, 'I hit a snag with that. Try again in a moment.').catch(() => {});
  }
}

async function handleCommand(client: TelegramClient, chatId: number, account: Account, text: string): Promise<void> {
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/start':
      if (account.onboardedAt) {
        await client.sendMessage(chatId, "You're all set. Use /paper for a paper now, /reset to start over, or just tell me what to track.");
      } else {
        await client.sendMessage(chatId, esc(await startOnboarding(account.id)));
      }
      return;
    case '/reset':
      await resetAccountData(account.id);
      await client.sendMessage(chatId, 'Wiped clean. Starting fresh.');
      await client.sendMessage(chatId, esc(await startOnboarding(account.id)));
      return;
    case '/help':
      await client.sendMessage(chatId, HELP);
      return;
    case '/profile':
      await client.sendMessage(chatId, await profileText(account.id));
      return;
    case '/paper':
      await sendBrief(client, chatId, account.id, { reset: true });
      return;
    case '/feedback':
      if (!arg) {
        await client.sendMessage(chatId, 'Add your note after the command, for example: /feedback the briefs are a little long.');
        return;
      }
      await client.sendMessage(chatId, replyToHtml(await handleUserMessage({ accountId: account.id, text: `feedback: ${arg}` })));
      return;
    case '/connect':
      await handleConnect(client, chatId, account.id, arg);
      return;
    default:
      await client.sendMessage(chatId, 'Just tell me in plain language: "ignore crypto", "track inference pricing", or "remember that I am moving house". Use /paper for a paper now.');
  }
}

async function handleConnect(client: TelegramClient, chatId: number, accountId: string, arg: string): Promise<void> {
  const parts = arg.split(/\s+/).filter(Boolean);
  const first = parts[0]?.toLowerCase();

  // OAuth servers: "/connect creed" or "/connect oauth <name> <url>".
  if (first === 'creed' || first === 'oauth') {
    const name = first === 'creed' ? 'creed' : parts[1];
    const url = first === 'creed' ? 'https://creed.md/mcp' : parts[2];
    if (!name || !url) {
      await client.sendMessage(chatId, 'Usage: /connect creed\nor: /connect oauth &lt;name&gt; &lt;url&gt;');
      return;
    }
    await client.sendChatAction(chatId);
    let handle;
    try {
      handle = await beginOAuthConnect({ accountId, name, serverUrl: url, redirectUrl: REDIRECT_URL });
    } catch (e) {
      await client.sendMessage(chatId, `Could not start OAuth for ${esc(name)}: ${esc((e as Error).message)}`);
      return;
    }
    if (handle.status === 'connected') {
      const r = handle.immediate!;
      await client.sendMessage(chatId, r.ok ? `Connected ${esc(name)} (already authorized). Pulled ${r.chars} characters into your context.` : `Connected, but pulled no content: ${esc(r.error ?? '')}`);
      return;
    }
    await client.sendMessage(
      chatId,
      `<a href="${esc(handle.authorizeUrl!)}">Tap to authorize Winnow to read your ${esc(name)}</a>\n\nApprove it in the browser and I will pull it in automatically. The link is good for a few minutes.`,
    );
    let code: string;
    try {
      code = await waitForCode(handle.state!);
    } catch {
      await client.sendMessage(chatId, `That authorization timed out. Run /connect ${esc(name)} again when you are ready.`);
      return;
    }
    await client.sendChatAction(chatId);
    try {
      const r = await handle.finish!(code);
      await client.sendMessage(chatId, r.ok ? `Connected <b>${esc(name)}</b>. Pulled ${r.chars} characters via ${esc(r.tools.join(', ') || 'it')} into your context. It will sharpen your next paper.` : `Authorized, but pulled no content: ${esc(r.error ?? '')}`);
    } catch (e) {
      await client.sendMessage(chatId, `Authorization failed: ${esc((e as Error).message)}`);
    }
    return;
  }

  // Token-based servers: "/connect <name> <url> <token>".
  const [name, url, token] = parts;
  if (!name || !url || !token) {
    await client.sendMessage(chatId, 'Usage:\n/connect creed\n/connect &lt;name&gt; &lt;url&gt; &lt;token&gt;');
    return;
  }
  await client.sendChatAction(chatId);
  const r = await connectMcp(accountId, { name, url, token });
  if (r.ok) {
    await client.sendMessage(chatId, `Connected <b>${esc(name)}</b>. Pulled ${r.chars} characters into your context.`);
  } else {
    await client.sendMessage(chatId, `Could not connect ${esc(name)}: ${esc(r.error ?? 'unknown error')}`);
  }
}

async function runEffects(
  client: TelegramClient,
  chatId: number,
  accountId: string,
  effects: import('../core/schema/domain').ReplyEffect[] | undefined,
): Promise<void> {
  for (const eff of effects ?? []) {
    if (eff.kind === 'trigger_deep_dive') {
      await client.sendChatAction(chatId);
      await client.sendMessage(chatId, replyToHtml(await handleDeepDive(accountId, eff.itemId)));
    } else if (eff.kind === 'trigger_brief') {
      await sendBrief(client, chatId, accountId, { reset: false });
    }
  }
}

async function sendBrief(client: TelegramClient, chatId: number, accountId: string, opts: { reset: boolean }): Promise<void> {
  if (opts.reset) {
    await db.delete(usageDaily).where(eq(usageDaily.accountId, accountId));
    await db.delete(generationLocks).where(eq(generationLocks.accountId, accountId));
  }
  await client.sendChatAction(chatId);
  const res = await generateBrief(accountId, { reason: opts.reset ? 'manual' : 'onboarding' });

  if (!res.ok) {
    if (res.reason === 'limit_reached') await client.sendMessage(chatId, "You've already had today's paper. Use /paper to generate a fresh one.");
    else if (res.reason === 'model_error' && !hasOpenRouterKey()) await client.sendMessage(chatId, 'I need an OpenRouter key to write papers. Set OPENROUTER_API_KEY and try /paper.');
    else await client.sendMessage(chatId, 'I hit a snag generating that brief and I am on it. Your next brief runs as normal.');
    return;
  }

  const brief = res.brief;
  await client.sendRichMessage(
    chatId,
    paperPreviewRich(brief),
    paperPreviewHtml(brief),
    paperFeedbackKeyboard(res.briefId),
  );

  // The full newspaper (with why-it-matters, signal, action) as an attached HTML file.
  if (brief.items.length > 0) {
    try {
      await client.sendDocument(chatId, `winnow-${brief.edition_date}.html`, renderEditionHtml(brief));
    } catch (e) {
      log.warn('send_edition_failed', { error: (e as Error).message });
    }
  }
}

async function profileText(accountId: string): Promise<string> {
  const p = await getProfile(accountId);
  if (!p?.personaSummary) return 'I do not have your profile yet. Send /start.';
  const interests = await getInterests(accountId);
  const pos = interests.filter((i) => i.weight > 0).map((i) => i.label).slice(0, 12);
  const neg = interests.filter((i) => i.weight < 0).map((i) => i.label).slice(0, 12);
  const ctx = await contextSummary(accountId);
  const conns = await listConnections(accountId);
  return [
    '<b>What I understand about you</b>',
    esc(p.personaSummary),
    '',
    `<b>Tracking:</b> ${esc(pos.join(', ') || 'nothing yet')}`,
    `<b>Ignoring:</b> ${esc(neg.join(', ') || 'nothing yet')}`,
    `<b>Timezone:</b> ${esc(p.timezone ?? 'UTC')}`,
    `<b>Context:</b> ${ctx.count} item${ctx.count === 1 ? '' : 's'} captured`,
    `<b>Connected:</b> ${esc(conns.map((c) => c.name).join(', ') || 'none yet, try /connect creed [token]')}`,
  ].join('\n');
}
