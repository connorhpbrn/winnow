import { eq } from 'drizzle-orm';
import { db } from '../../lib/db';
import { sources as sourcesTable, stories } from '../schema/tables';
import { canonicalizeUrl } from './canonical';
import { fetchSource } from './fetchers';
import { log } from '../../lib/log';
import type { StoryId } from '../schema/domain';

export interface IngestResult {
  inserted: StoryId[];
  skippedDuplicates: number;
  sourceErrors: Array<{ sourceId: string; name: string; error: string }>;
}

/**
 * Fetch active sources, normalise, canonicalise URLs, dedupe vs stories.canonical_url,
 * insert new rows. NO model calls here (summarisation is a separate step). One bad feed
 * is logged and skipped, never blocks the pool (spec Section 17).
 */
export async function ingestSources(opts?: { sinceHours?: number }): Promise<IngestResult> {
  const active = (await db.select().from(sourcesTable).where(eq(sourcesTable.active, true))).filter((source) =>
    ['rss', 'hn', 'github_releases', 'blog', 'changelog'].includes(source.kind),
  );
  const sourceErrors: IngestResult['sourceErrors'] = [];
  const candidates: Array<{ sourceId: string; canonicalUrl: string; title: string; publishedAt: Date | null; raw: unknown }> = [];

  for (const src of active) {
    try {
      const items = await fetchSource(src);
      for (const it of items) {
        candidates.push({
          sourceId: src.id,
          canonicalUrl: canonicalizeUrl(it.url),
          title: it.title.slice(0, 500),
          publishedAt: it.publishedAt,
          raw: { snippet: it.snippet, image: it.image, original: it.raw },
        });
      }
    } catch (e) {
      sourceErrors.push({ sourceId: src.id, name: src.name, error: (e as Error).message });
      log.warn('source_fetch_failed', { source: src.name, error: (e as Error).message });
    }
  }

  // Optional recency filter (drops items published before the window).
  const filtered =
    opts?.sinceHours == null
      ? candidates
      : candidates.filter((c) => !c.publishedAt || c.publishedAt.getTime() >= Date.now() - opts.sinceHours! * 3_600_000);

  // Dedupe within this batch by canonical URL before insert.
  const seen = new Set<string>();
  const unique = filtered.filter((c) => (seen.has(c.canonicalUrl) ? false : (seen.add(c.canonicalUrl), true)));

  if (unique.length === 0) return { inserted: [], skippedDuplicates: 0, sourceErrors };

  // onConflictDoNothing on canonical_url => only genuinely-new rows are returned.
  const inserted = await db
    .insert(stories)
    .values(
      unique.map((c) => ({
        sourceId: c.sourceId,
        canonicalUrl: c.canonicalUrl,
        title: c.title,
        publishedAt: c.publishedAt ?? null,
        raw: c.raw,
      })),
    )
    .onConflictDoNothing({ target: stories.canonicalUrl })
    .returning({ id: stories.id });

  const insertedIds = inserted.map((r) => r.id);
  return { inserted: insertedIds, skippedDuplicates: unique.length - insertedIds.length, sourceErrors };
}
