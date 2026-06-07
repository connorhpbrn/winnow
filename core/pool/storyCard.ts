import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../lib/db';
import { stories, sources, type StoryRow } from '../schema/tables';
import { callModel } from '../models/client';
import { log } from '../../lib/log';
import type { StoryId } from '../schema/domain';

// Cached, paraphrased, copyright-safe view of a pool story used by ranking + composition.
export interface StoryCard {
  id: string;
  canonicalUrl: string;
  title: string;
  summary: string;
  topics: string[];
  credibilityScore: number;
  credibilityTier: number;
  publishedAt: string | null;
  ingestedAt: string;
  sourceName: string;
  category?: string;
  image?: { url: string; alt?: string; credit?: string };
  sourceRefs: Array<{ title: string; url: string; publisher?: string }>;
  eventKey: string | null;
  revision: number;
  isUpdate: boolean;
  claims: Array<{ text: string; sourceUrls: string[] }>;
}

const TIER_BASE: Record<number, number> = { 1: 0.9, 2: 0.65, 3: 0.4 };

/** Deterministic tier -> score, optionally nudged by a confirmed-vs-rumour signal (Section 9.4). */
export function scoreCredibility(input: { sourceTier: number; rumourSignal?: number }): number {
  const base = TIER_BASE[input.sourceTier] ?? 0.5;
  if (input.rumourSignal === undefined) return round2(base);
  const nudge = (input.rumourSignal - 0.5) * 0.2; // rumourSignal in [0,1] = confidence it is confirmed
  return round2(clamp(base + nudge, 0, 1));
}

const SummarySchema = z.object({
  summary: z.string(),
  topics: z.array(z.string()).default([]),
  confirmed: z.boolean().default(true),
});

/**
 * One bulk-model call: paraphrased summary (<=60 words, copyright-safe), topic extraction,
 * credibility nudge. Persists onto the stories row. Idempotent: a story already summarised
 * returns its cached card without another model call.
 */
export async function summariseStory(storyId: StoryId): Promise<StoryCard> {
  const row = (await db.select().from(stories).where(eq(stories.id, storyId)).limit(1))[0];
  if (!row) throw new Error(`story ${storyId} not found`);

  const srcRow = row.sourceId
    ? (await db.select().from(sources).where(eq(sources.id, row.sourceId)).limit(1))[0]
    : undefined;
  const tier = srcRow?.credibilityTier ?? 2;
  const sourceName = srcRow?.name ?? 'unknown';

  if (row.summary) return toStoryCard(row, sourceName, tier); // idempotent

  const system =
    'You summarise one news or release item for a tech-savvy reader. Rules: paraphrase in your own words, never copy sentences from the source, keep the summary to 60 words or fewer, no hype, no em dashes. Extract 3 to 8 short topic tags (entities, companies, technologies, products). Return JSON {"summary": string, "topics": string[], "confirmed": boolean}, where confirmed is false if this reads as rumour or speculation.';
  const user = `TITLE: ${row.title}\nSOURCE: ${sourceName}\nURL: ${row.canonicalUrl ?? ''}\nCONTENT: ${extractSnippet(row.raw)}`;

  let parsed: z.infer<typeof SummarySchema>;
  try {
    const res = await callModel({ role: 'bulk', system, user, json: true, maxTokens: 400 });
    parsed = SummarySchema.parse(JSON.parse(res.content));
  } catch (e) {
    log.warn('summarise_fallback', { storyId, error: (e as Error).message });
    parsed = { summary: truncateWords(row.title, 60), topics: [], confirmed: true };
  }

  const summary = truncateWords(parsed.summary, 60);
  const topics = normaliseTopics(parsed.topics);
  const credibilityScore = scoreCredibility({ sourceTier: tier, rumourSignal: parsed.confirmed ? 0.9 : 0.4 });

  const updated = (
    await db.update(stories).set({ summary, topics, credibilityScore }).where(eq(stories.id, storyId)).returning()
  )[0];
  return toStoryCard(updated ?? row, sourceName, tier);
}

export function toStoryCard(row: StoryRow, sourceName: string, tier: number): StoryCard {
  return {
    id: row.id,
    canonicalUrl: row.canonicalUrl ?? '',
    title: row.title,
    summary: row.summary ?? '',
    topics: row.topics ?? [],
    credibilityScore: row.credibilityScore ?? scoreCredibility({ sourceTier: tier }),
    credibilityTier: tier,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    ingestedAt: row.ingestedAt.toISOString(),
    sourceName,
    category: extractCategory(row.raw),
    image: extractImage(row.raw),
    sourceRefs: extractSourceRefs(row.raw, row.canonicalUrl ?? '', sourceName),
    eventKey: row.eventKey,
    revision: row.revision,
    isUpdate: row.revision > 1,
    claims: extractClaims(row.evidence),
  };
}

function extractCategory(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const category = (raw as Record<string, unknown>).category;
  return typeof category === 'string' ? category.toLowerCase() : undefined;
}

function extractSnippet(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const r = raw as Record<string, unknown>;
  const s = (r.snippet ?? '') as string;
  return String(s).slice(0, 1200);
}

function extractImage(raw: unknown): StoryCard['image'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const image = (raw as Record<string, unknown>).image;
  if (!image || typeof image !== 'object') return undefined;
  const value = image as Record<string, unknown>;
  if (typeof value.url !== 'string') return undefined;
  return {
    url: value.url,
    alt: typeof value.alt === 'string' ? value.alt : undefined,
    credit: typeof value.credit === 'string' ? value.credit : undefined,
  };
}

function extractSourceRefs(raw: unknown, canonicalUrl: string, sourceName: string): StoryCard['sourceRefs'] {
  if (raw && typeof raw === 'object') {
    const refs = (raw as Record<string, unknown>).sources;
    if (Array.isArray(refs)) {
      const clean = refs
        .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
        .map((r) => ({
          title: typeof r.title === 'string' ? r.title : typeof r.publisher === 'string' ? r.publisher : 'Source',
          url: typeof r.url === 'string' ? r.url : '',
          publisher: typeof r.publisher === 'string' ? r.publisher : undefined,
        }))
        .filter((r) => isHttpUrl(r.url))
        .slice(0, 5);
      if (clean.length) return clean;
    }
  }
  return canonicalUrl ? [{ title: sourceName, url: canonicalUrl, publisher: sourceName }] : [];
}

function extractClaims(evidence: unknown): StoryCard['claims'] {
  if (!evidence || typeof evidence !== 'object') return [];
  const claims = (evidence as Record<string, unknown>).claims;
  if (!Array.isArray(claims)) return [];
  return claims
    .filter((claim): claim is Record<string, unknown> => Boolean(claim) && typeof claim === 'object')
    .map((claim) => ({
      text: typeof claim.text === 'string' ? claim.text : '',
      sourceUrls: Array.isArray(claim.source_urls) ? claim.source_urls.filter((url): url is string => typeof url === 'string') : [],
    }))
    .filter((claim) => claim.text && claim.sourceUrls.length)
    .slice(0, 12);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function truncateWords(s: string, n: number): string {
  const words = s.trim().split(/\s+/);
  return words.length <= n ? s.trim() : words.slice(0, n).join(' ');
}

function normaliseTopics(topics: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of topics) {
    const clean = t.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out.slice(0, 8);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
