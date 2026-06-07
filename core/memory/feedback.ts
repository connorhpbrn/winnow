import { and, eq } from 'drizzle-orm';
import { db } from '../../lib/db';
import { briefs, memoryEvents, interests, stories } from '../schema/tables';
import type { AccountId, StoryId } from '../schema/domain';

export type MemoryEventType =
  | 'ignore'
  | 'more_like'
  | 'less_like'
  | 'more_detail'
  | 'track'
  | 'untrack'
  | 'brief_good'
  | 'brief_bad';

// How each feedback signal shifts a label's weight when folded.
const DELTA: Record<MemoryEventType, number> = {
  track: 3,
  more_like: 1.5,
  more_detail: 0, // a style signal, not a weight signal
  less_like: -1.5,
  ignore: -3,
  untrack: -5,
  brief_good: 0.5,
  brief_bad: -0.2,
};

export async function recordBriefFeedback(
  accountId: AccountId,
  briefId: string,
  rating: 'good' | 'bad',
): Promise<void> {
  const row = (
    await db
      .select({ payload: briefs.payload })
      .from(briefs)
      .where(and(eq(briefs.id, briefId), eq(briefs.accountId, accountId)))
      .limit(1)
  )[0];
  if (!row) return;
  const payload = row.payload as { items?: Array<{ id?: string; genres?: Array<{ label?: string }> }> };
  const itemIds = (payload.items ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
  const storyRows = itemIds.length
    ? await Promise.all(itemIds.map((id) => db.select({ topics: stories.topics }).from(stories).where(eq(stories.id, id)).limit(1)))
    : [];
  const labels = [
    ...(payload.items ?? []).flatMap((item) => item.genres?.map((genre) => genre.label ?? '') ?? []),
    ...storyRows.flatMap((rows) => rows[0]?.topics ?? []),
  ]
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean)
    .filter((label, index, all) => all.indexOf(label) === index)
    .slice(0, 16);

  const type: MemoryEventType = rating === 'good' ? 'brief_good' : 'brief_bad';
  if (labels.length === 0) {
    await recordMemoryEvent(accountId, { type, payload: { briefId, rating } });
  } else {
    for (const label of labels) {
      await recordMemoryEvent(accountId, { type, payload: { briefId, rating, label } });
    }
  }
  await foldFeedbackIntoInterests(accountId);
}

/** Append a personalisation signal. Never mutates history (spec: memory_events is append-only). */
export async function recordMemoryEvent(
  accountId: AccountId,
  ev: { type: MemoryEventType; payload?: Record<string, unknown>; relatedStoryId?: StoryId },
): Promise<void> {
  await db.insert(memoryEvents).values({
    accountId,
    type: ev.type,
    payload: ev.payload ?? {},
    relatedStoryId: ev.relatedStoryId ?? null,
  });
}

/**
 * Fold the append-only event log into signed interest weights (spec Section 6 note).
 * Idempotent: recomputes the source='feedback' interests from the full event history each
 * time, so repeated folds converge rather than double-count. Onboarding interests are left
 * intact; ranking sums weights per label across sources.
 */
export async function foldFeedbackIntoInterests(accountId: AccountId): Promise<{ created: number }> {
  const events = await db
    .select()
    .from(memoryEvents)
    .where(eq(memoryEvents.accountId, accountId))
    .orderBy(memoryEvents.createdAt);

  const net = new Map<string, number>();
  for (const ev of events) {
    const label = extractLabel(ev.payload);
    if (!label) continue;
    const delta = DELTA[ev.type as MemoryEventType] ?? 0;
    if (delta === 0) continue;
    net.set(label, (net.get(label) ?? 0) + delta);
  }

  await db.delete(interests).where(and(eq(interests.accountId, accountId), eq(interests.source, 'feedback')));
  const rows = [...net.entries()]
    .filter(([, w]) => w !== 0)
    .map(([label, weight]) => ({ accountId, label, kind: 'topic', weight, source: 'feedback' }));
  if (rows.length) await db.insert(interests).values(rows);
  return { created: rows.length };
}

function extractLabel(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const raw = (p.label ?? p.topic ?? p.text) as string | undefined;
  const clean = raw?.trim().toLowerCase();
  return clean && clean.length >= 2 ? clean.slice(0, 40) : null;
}
