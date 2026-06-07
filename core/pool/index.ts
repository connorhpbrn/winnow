import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../lib/db';
import { stories, sources } from '../schema/tables';
import { toStoryCard, type StoryCard } from './storyCard';
import type { StoryId } from '../schema/domain';

export * from './ingest';
export * from './discover';
export * from './storyCard';
export { canonicalizeUrl } from './canonical';
export { seedSources, SEED_SOURCES, type SeedSource } from './sources';

export async function getStoryCard(id: StoryId): Promise<StoryCard | null> {
  const rows = await db
    .select({ story: stories, src: sources })
    .from(stories)
    .leftJoin(sources, eq(stories.sourceId, sources.id))
    .where(eq(stories.id, id))
    .limit(1);
  const r = rows[0];
  return r ? toStoryCard(r.story, r.src?.name ?? 'unknown', r.src?.credibilityTier ?? 2) : null;
}

export async function listRecentStories(
  opts: { sinceHours?: number; limit?: number; summarisedOnly?: boolean } = {},
): Promise<StoryCard[]> {
  const conds = [];
  if (opts.sinceHours != null) {
    conds.push(gte(stories.ingestedAt, new Date(Date.now() - opts.sinceHours * 3_600_000)));
  }
  if (opts.summarisedOnly) conds.push(isNotNull(stories.summary));

  const rows = await db
    .select({ story: stories, src: sources })
    .from(stories)
    .leftJoin(sources, eq(stories.sourceId, sources.id))
    .where(conds.length ? and(...conds) : sql`true`)
    .orderBy(desc(stories.ingestedAt))
    .limit(opts.limit ?? 100);

  return rows.map((r) => toStoryCard(r.story, r.src?.name ?? 'unknown', r.src?.credibilityTier ?? 2));
}
