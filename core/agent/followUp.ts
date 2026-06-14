import { desc, eq } from 'drizzle-orm';
import { db } from '../../lib/db';
import { briefs, productFeedback } from '../schema/tables';
import { callModel } from '../models/client';
import { hasOpenRouterKey } from '../../lib/env';
import { getProfile } from '../memory/profile';
import { addContext, getContextDigest, refreshContextDigest } from '../memory/context';
import { recordMemoryEvent, foldFeedbackIntoInterests, type MemoryEventType } from '../memory/feedback';
import { checkAndConsume } from '../limits/limits';
import { getStoryCard } from '../pool';
import { classifyIntent } from './intent';
import type { Brief, BriefItem } from '../schema/brief';
import { block, textReply, type InboundMessage, type Reply, type AccountId } from '../schema/domain';

// THE conversational entry point (spec Section 12.3). Transport-neutral: takes an
// InboundMessage, returns a Reply (semantic blocks + named effects). NEVER sends, NEVER
// imports Telegram. The adapter (Telegram router / CLI) renders the Reply and performs effects.
export async function handleUserMessage(msg: InboundMessage): Promise<Reply> {
  const { intent, args } = await classifyIntent({ text: msg.text, hasReplyContext: Boolean(msg.replyToItemId) });

  switch (intent) {
    case 'more':
      return handleMore(msg.accountId, { n: args?.n, itemId: msg.replyToItemId });
    case 'sources':
      return handleSources(msg.accountId, { n: args?.n, itemId: msg.replyToItemId });
    case 'deep': {
      const resolved = await resolveItem(msg.accountId, { n: args?.n, itemId: msg.replyToItemId });
      if (!resolved) return textReply('Tell me which item to dig into, for example "deep 2".');
      // Fast path: name the effect; the adapter/Trigger job runs the heavy fetch + reasoning call.
      return { blocks: [block.text(`Digging into "${resolved.item.headline}". One moment.`)], effects: [{ kind: 'trigger_deep_dive', itemId: resolved.item.id }] };
    }
    case 'track':
    case 'more_like':
      return handleSignal(msg, intent === 'track' ? 'track' : 'more_like', args?.label, true);
    case 'ignore':
    case 'less_like':
    case 'untrack':
      return handleSignal(msg, intent, args?.label, false);
    case 'feedback': {
      const message = args?.text || msg.text;
      await db.insert(productFeedback).values({ accountId: msg.accountId, message });
      return textReply('Passed that to the Winnow team. Thank you, it genuinely helps.');
    }
    case 'remember': {
      const content = args?.text?.trim() || msg.text.trim();
      await addContext(msg.accountId, { source: 'remember', label: 'user context', content });
      await refreshContextDigest(msg.accountId);
      return textReply('Got it. I have added that to your context. Use /paper and I will rebuild the paper around it.');
    }
    case 'edit_schedule':
      return textReply('Papers are generated on demand. Use /paper whenever you want a fresh one.');
    case 'edit_topics':
      return textReply('You can manage tracked and ignored topics in settings, or just tell me, for example "ignore crypto" or "track inference pricing".');
    case 'follow_up':
      return handleFollowUp(msg);
    case 'smalltalk':
      return textReply('I am here and watching. Tell me what you want tracked or ignored.');
    default:
      return textReply('I did not catch that. Tell me what you want tracked or ignored.');
  }
}

async function handleSignal(
  msg: InboundMessage,
  type: MemoryEventType,
  label: string | undefined,
  positive: boolean,
): Promise<Reply> {
  const resolved = label ?? (await labelFromItem(msg.replyToItemId));
  if (!resolved) {
    return textReply(positive ? 'What should I track? For example "track inference pricing".' : 'What should I show you less of? For example "ignore crypto".');
  }
  await recordMemoryEvent(msg.accountId, { type, payload: { label: resolved }, relatedStoryId: msg.replyToItemId });
  await foldFeedbackIntoInterests(msg.accountId);
  const verb =
    type === 'track' || type === 'more_like'
      ? `I'll bring you more on ${resolved}.`
      : type === 'untrack'
        ? `I'll stop tracking ${resolved}.`
        : `I'll keep ${resolved} out of your briefs unless it directly affects you.`;
  return textReply(`Done. ${verb}`);
}

/** Direct dispatch by explicit item id (used by tap buttons). Robust: no number resolution. */
export async function handleItemAction(
  accountId: AccountId,
  action: 'more' | 'deep' | 'sources',
  itemId: string,
): Promise<Reply> {
  if (action === 'deep') return handleDeepDive(accountId, itemId);
  if (action === 'sources') return handleSources(accountId, { itemId });
  return handleMore(accountId, { itemId });
}

async function handleMore(accountId: AccountId, ref: { n?: string; itemId?: string }): Promise<Reply> {
  const resolved = await resolveItem(accountId, ref);
  if (!resolved) return textReply('Tell me which item to expand, for example "more 2".');
  const item = resolved.item;
  if (!hasOpenRouterKey()) {
    return { blocks: [block.text(`${item.headline}\n\n${item.what_changed}\n\nWhy it matters: ${item.why_it_matters}`), block.link(item.sources[0]?.title ?? 'Source', item.sources[0]?.url ?? '')] };
  }
  const profile = await getProfile(accountId);
  const context = await getContextDigest(accountId);
  const system = `You are Winnow, a skeptical high-signal analyst. Expand on one brief item for this person in their preferred style (${profile?.writingStyle ?? 'balanced'}). Paraphrase only, no reproduced text, any quote under 15 words, no em dashes. Keep it tight.`;
  const user = `PERSON: ${profile?.personaSummary ?? ''}\nFULL CONTEXT: ${context}\n\nITEM: ${item.headline}\nWHAT CHANGED: ${item.what_changed}\nWHY IT MATTERS: ${item.why_it_matters}\nSIGNAL: ${item.signal_quality} (${item.signal_note})\n\nExpand with the most useful extra context and what to watch next.`;
  const res = await callModel({ role: 'reasoning', system, user, maxTokens: 400 });
  return { blocks: [block.text(res.content.trim()), block.link(item.sources[0]?.title ?? 'Source', item.sources[0]?.url ?? '')] };
}

async function handleSources(accountId: AccountId, ref: { n?: string; itemId?: string }): Promise<Reply> {
  const resolved = await resolveItem(accountId, ref);
  if (!resolved) return textReply('Which item? For example "sources 2".');
  return { blocks: resolved.item.sources.map((s) => block.link(s.publisher ? `${s.title} (${s.publisher})` : s.title, s.url)) };
}

async function handleFollowUp(msg: InboundMessage): Promise<Reply> {
  const brief = await loadLatestBrief(msg.accountId);
  if (!hasOpenRouterKey() || !brief) {
    return textReply('I can answer questions about your latest brief once it is generated.');
  }
  const profile = await getProfile(msg.accountId);
  const context = await getContextDigest(msg.accountId);
  const system = `You are Winnow, a skeptical high-signal analyst for this person. Answer their question using only the brief below and your general knowledge, paraphrased, no em dashes, in their style (${profile?.writingStyle ?? 'balanced'}). If the brief does not cover it, say so honestly.`;
  const user = `PERSON: ${profile?.personaSummary ?? ''}\nFULL CONTEXT: ${context}\n\nBRIEF: ${JSON.stringify(brief.items.map((i) => ({ headline: i.headline, what_changed: i.what_changed, why: i.why_it_matters })))}\n\nQUESTION: ${msg.text}`;
  const res = await callModel({ role: 'reasoning', system, user, maxTokens: 400 });
  return textReply(res.content.trim());
}

/**
 * Deep dive (spec Section 10.4), run by the Trigger job (or inline in the CLI). Cached card +
 * a single live fetch of the primary source + one reasoning call. Enforces the deep-dive limit.
 */
export async function handleDeepDive(accountId: AccountId, itemId: string): Promise<Reply> {
  const item = await findItem(accountId, itemId);
  if (!item) return textReply('I could not find that item to dig into.');

  const limit = await checkAndConsume(accountId, 'deep_dive');
  if (!limit.allowed) return textReply(limit.message!);

  if (!hasOpenRouterKey()) {
    return textReply('Deep dives need the model configured. For now: ' + item.why_it_matters);
  }

  const url = item.sources[0]?.url ?? '';
  const fetched = url ? await fetchReadableText(url) : '';
  const profile = await getProfile(accountId);
  const system = `You are Winnow, a skeptical high-signal analyst for this person. Write a deeper but honest analysis of one item, paraphrased in your own words (never reproduce text, any quote under 15 words and attributed), no em dashes, in their style (${profile?.writingStyle ?? 'balanced'}). Be concrete about what it means for them and what to watch. Around 150 to 220 words.`;
  const user = `PERSON: ${profile?.personaSummary ?? ''}\n\nITEM: ${item.headline}\nWHAT CHANGED: ${item.what_changed}\nWHY IT MATTERS: ${item.why_it_matters}\nSOURCE TEXT (may be partial): ${fetched.slice(0, 3000) || '(could not fetch, use the summary)'}\n\nWrite the deeper analysis.`;
  const res = await callModel({ role: 'reasoning', system, user, maxTokens: 600 });
  return { blocks: [block.text(res.content.trim()), block.link(item.sources[0]?.title ?? 'Source', url)] };
}

// ---- helpers ----

async function loadLatestBrief(accountId: AccountId): Promise<Brief | null> {
  const rows = await db.select({ payload: briefs.payload }).from(briefs).where(eq(briefs.accountId, accountId)).orderBy(desc(briefs.createdAt)).limit(1);
  return rows[0] ? (rows[0].payload as Brief) : null;
}

async function findItem(accountId: AccountId, itemId: string): Promise<BriefItem | null> {
  const rows = await db.select({ payload: briefs.payload }).from(briefs).where(eq(briefs.accountId, accountId)).orderBy(desc(briefs.createdAt)).limit(10);
  for (const r of rows) {
    const found = (r.payload as Brief).items.find((i) => i.id === itemId);
    if (found) return found;
  }
  return null;
}

async function resolveItem(accountId: AccountId, ref: { n?: string; itemId?: string }): Promise<{ item: BriefItem } | null> {
  if (ref.itemId) {
    const item = await findItem(accountId, ref.itemId);
    if (item) return { item };
  }
  if (ref.n) {
    const brief = await loadLatestBrief(accountId);
    const item = brief?.items[parseInt(ref.n, 10) - 1];
    if (item) return { item };
  }
  return null;
}

async function labelFromItem(itemId?: string): Promise<string | null> {
  if (!itemId) return null;
  const card = await getStoryCard(itemId);
  return card?.topics[0] ?? null;
}

async function fetchReadableText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'WinnowBot/0.1' } });
    if (!res.ok) return '';
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}
