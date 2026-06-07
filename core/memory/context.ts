import { and, desc, eq, gt } from 'drizzle-orm';
import { db } from '../../lib/db';
import { contextItems, userProfiles, type ContextItem } from '../schema/tables';
import { callModel } from '../models/client';
import { hasOpenRouterKey } from '../../lib/env';
import { log } from '../../lib/log';
import type { AccountId } from '../schema/domain';

// The context store: everything the user gives Winnow (onboarding dump, files, forwards,
// /remember, MCP fetches) accumulates here, is compacted into a digest, and injected into
// the composer so papers get sharper as more context is captured.

const PER_ITEM_CAP = 50_000; // chars per stored item
const DIGEST_INPUT_CAP = 60_000; // preserve rich connected profiles such as Creed
const DIGEST_OUT_TOKENS = 1200;

export async function addContext(
  accountId: AccountId,
  item: { source: string; label?: string; content: string },
): Promise<void> {
  const content = item.content.trim();
  if (!content) return;
  await db.insert(contextItems).values({
    accountId,
    source: item.source,
    label: item.label ?? null,
    content: content.slice(0, PER_ITEM_CAP),
  });
}

export async function contextSummary(accountId: AccountId): Promise<{ count: number; sources: string[] }> {
  const rows = await db.select({ source: contextItems.source }).from(contextItems).where(eq(contextItems.accountId, accountId));
  return { count: rows.length, sources: [...new Set(rows.map((r) => r.source))] };
}

/**
 * Return the compacted context digest for the composer, regenerating it when new context has
 * been captured since the last digest. Cheap (bulk model). Empty string when there is nothing.
 */
export async function getContextDigest(accountId: AccountId): Promise<string> {
  const prof = (await db.select({ digest: userProfiles.contextDigest, at: userProfiles.contextDigestAt }).from(userProfiles).where(eq(userProfiles.accountId, accountId)).limit(1))[0];
  const digestAt = prof?.at ?? null;

  // Anything new since the last digest?
  const newer = await db
    .select({ id: contextItems.id })
    .from(contextItems)
    .where(digestAt ? and(eq(contextItems.accountId, accountId), gt(contextItems.createdAt, digestAt)) : eq(contextItems.accountId, accountId))
    .limit(1);

  if (newer.length === 0) return prof?.digest ?? '';

  const items = await db.select().from(contextItems).where(eq(contextItems.accountId, accountId)).orderBy(desc(contextItems.createdAt));
  if (items.length === 0) return '';
  return regenerate(accountId, items);
}

export async function refreshContextDigest(accountId: AccountId): Promise<string> {
  const items = await db.select().from(contextItems).where(eq(contextItems.accountId, accountId)).orderBy(desc(contextItems.createdAt));
  if (items.length === 0) return '';
  return regenerate(accountId, items);
}

async function regenerate(accountId: AccountId, items: ContextItem[]): Promise<string> {
  const profile = (
    await db
      .select({
        bio: userProfiles.bioRaw,
        work: userProfiles.workingOnRaw,
        persona: userProfiles.personaSummary,
      })
      .from(userProfiles)
      .where(eq(userProfiles.accountId, accountId))
      .limit(1)
  )[0];
  const rawOnboarding = [
    profile?.bio ? `ABOUT THEM:\n${profile.bio}` : '',
    profile?.work ? `CURRENT WORK:\n${profile.work}` : '',
    profile?.persona ? `DERIVED PROFILE:\n${profile.persona}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const input = [rawOnboarding, buildDigestInput(items)].filter(Boolean).join('\n\n').slice(0, DIGEST_INPUT_CAP);

  let digest: string;
  if (hasOpenRouterKey()) {
    try {
      const system =
        'Build a high-fidelity editorial intelligence profile from everything this person has shared. This profile will decide what news is searched for, selected, ignored, and explained. Preserve specific products, projects, companies, people, roles, sectors, locations, tools, technologies, competitors, goals, active decisions, constraints, tastes, explicit dislikes, and time-sensitive priorities. Distinguish current work from parked ideas and strong interests from incidental mentions. Keep negative preferences and do-not-cover signals. Remove repetition and decorative prose, but do not flatten meaningful nuance. Use compact labelled sections. No em dashes. Stay under 550 words.';
      const res = await callModel({ role: 'bulk', system, user: input, maxTokens: DIGEST_OUT_TOKENS });
      digest = res.content.trim();
    } catch (e) {
      log.warn('context_digest_fallback', { error: (e as Error).message });
      digest = input.slice(0, 4000);
    }
  } else {
    digest = input.slice(0, 4000);
  }

  // Upsert so the digest persists even when context arrives before onboarding creates the row.
  await db
    .insert(userProfiles)
    .values({ accountId, contextDigest: digest, contextDigestAt: new Date() })
    .onConflictDoUpdate({ target: userProfiles.accountId, set: { contextDigest: digest, contextDigestAt: new Date(), updatedAt: new Date() } });
  return digest;
}

function buildDigestInput(items: ContextItem[]): string {
  // Connected canonical profiles are the richest source and should not be crowded out by
  // newer one-line messages. Keep each source represented, then spend remaining space on
  // the full high-value snapshots.
  const ordered = [...items].sort((a, b) => {
    const aPriority = a.source.startsWith('mcp:') ? 0 : 1;
    const bPriority = b.source.startsWith('mcp:') ? 0 : 1;
    return aPriority - bPriority || b.createdAt.getTime() - a.createdAt.getTime();
  });
  const blocks = ordered.map((i) => `[${i.source}${i.label ? `: ${i.label}` : ''}]\n${i.content}`);
  const minimums = blocks.map((block) => block.slice(0, 2_000));
  let input = minimums.join('\n\n').slice(0, DIGEST_INPUT_CAP);
  for (let i = 0; i < blocks.length && input.length < DIGEST_INPUT_CAP; i++) {
    const remainder = blocks[i]!.slice(minimums[i]!.length);
    if (!remainder) continue;
    input += `\n\n[continued]\n${remainder.slice(0, DIGEST_INPUT_CAP - input.length)}`;
  }
  return input.slice(0, DIGEST_INPUT_CAP);
}
