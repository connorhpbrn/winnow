import { z } from 'zod';
import { and, desc, eq, gte, isNotNull } from 'drizzle-orm';
import { db } from '../../lib/db';
import { accounts, interests, sources, stories, userProfiles } from '../schema/tables';
import { callModel } from '../models/client';
import { canonicalizeUrl } from './canonical';
import { log } from '../../lib/log';
import { buildCoveragePlan } from '../memory/coverage';

const ResearchSourceSchema = z.object({
  title: z.string(),
  url: z.url(),
  publisher: z.string(),
  primary: z.boolean().default(false),
});

const ResearchStorySchema = z.object({
  headline: z.string(),
  summary: z.string(),
  category: z.enum(['world', 'politics', 'business', 'finance', 'science', 'health', 'culture', 'sport', 'technology', 'other']),
  event_key: z.string(),
  topics: z.array(z.string()).min(1).max(10),
  published_at: z.string().optional(),
  sources: z.array(ResearchSourceSchema).min(1).max(5),
  image: z
    .object({
      url: z.url(),
      alt: z.string(),
      credit: z.string().optional(),
    })
    .optional(),
});

const ResearchResultSchema = z.object({
  stories: z.array(ResearchStorySchema).max(12),
});

export type ResearchStory = z.infer<typeof ResearchStorySchema>;

interface VerifiedSource {
  url: string;
  title: string;
  publisher: string;
  primary: boolean;
  publishedAt: string | null;
  text: string;
}

interface GroundedStory {
  headline: string;
  summary: string;
  published_at: string;
  claims: Array<{ text: string; source_urls: string[] }>;
}

const GroundedStorySchema = z.object({
  headline: z.string(),
  summary: z.string(),
  published_at: z.string(),
  claims: z.array(z.object({ text: z.string(), source_urls: z.array(z.url()).min(1) })).min(1).max(12),
});

export interface DiscoveryResult {
  searched: number;
  discovered: number;
  inserted: number;
  storyIds: string[];
  rejected: number;
  verificationFailed: number;
  errors: string[];
}

const BROAD_SEARCHES = [
  'The most consequential world and political news from the last 24 hours, including policy, elections, geopolitics, security, and major public decisions.',
  'The most consequential business, finance, markets, company, labour, and economic news from the last 24 hours.',
  'The most consequential science, health, climate, energy, space, and research news from the last 24 hours.',
  'The most consequential culture, media, entertainment, sport, consumer, and internet news from the last 24 hours.',
  'The most consequential technology, AI, software, hardware, startup, and digital policy news from the last 24 hours.',
] as const;

const SYSTEM = `You are the research desk for Winnow, a high-quality personal newspaper. Search the live web and X, then return distinct news events, not a list of links.

Editorial standard:
- Cover only material developments from the requested period. Exclude evergreen explainers, SEO pages, rumours without corroboration, trivial commentary, and duplicate angles on the same event.
- Do not equate importance with front-page coverage. A small release, filing, standards change, specialist-market movement, primary post, or niche community signal can be highly consequential when the assignment makes the connection specific.
- Search X for early signals and primary posts, but never treat an X post alone as verified. An X-originated event must also have an official source or credible independent reporting.
- Prefer sources in this order: official documents and first-party announcements; wire services and established specialist reporting; reputable national publications; everything else.
- For contested or consequential claims, include at least two independent sources where available.
- headline and summary must be neutral factual journalism. No hype, recommendations, personalisation, or references to the reader.
- Assign one category and a short event_key built from the central actors and action, stable across later updates.
- summary must be dense but readable: include what happened, who did it, when, the essential numbers or constraints, and enough background to understand the development. Do not omit important detail merely to be short.
- Use the most authoritative source URL as the first source and mark it primary=true. Never invent a URL.
- Include an image only when search finds a strong, relevant editorial image, chart, diagram, or product visual from a source page. Omit decorative images, logos, avatars, and low-quality thumbnails.
- Return only JSON matching the schema. No markdown. No em dashes.`;

export async function discoverNews(
  opts: {
    includePersonal?: boolean;
    maxPersonalSearches?: number;
    minIntervalHours?: number;
    force?: boolean;
    accountId?: string;
    personalOnly?: boolean;
  } = {},
): Promise<DiscoveryResult> {
  if (!opts.personalOnly && !opts.force && (await researchIsFresh(opts.minIntervalHours ?? 2))) {
    return { searched: 0, discovered: 0, inserted: 0, storyIds: [], rejected: 0, verificationFailed: 0, errors: [] };
  }
  const searches: string[] = opts.personalOnly ? [] : [...BROAD_SEARCHES];
  if (opts.includePersonal !== false) {
    searches.push(...(await personalSearches(opts.maxPersonalSearches ?? 20, opts.accountId)));
  }

  const all: ResearchStory[] = [];
  const errors: string[] = [];
  const searchResults = await mapConcurrent(searches, 3, async (query) => {
    try {
      return await runSearch(query);
    } catch (e) {
      const message = (e as Error).message;
      errors.push(message);
      log.warn('news_discovery_failed', { query: query.slice(0, 120), error: message });
      return [];
    }
  });
  all.push(...searchResults.flat());

  const sourceId = await researchSourceId();
  const recentEvents = await db
    .select()
    .from(stories)
    .where(gte(stories.updatedAt, new Date(Date.now() - 14 * 24 * 3_600_000)))
    .orderBy(desc(stories.updatedAt))
    .limit(500);
  let inserted = 0;
  const storyIds: string[] = [];
  let rejected = 0;
  let verificationFailed = 0;
  const seen = new Set<string>();
  const seenEvents = new Set<string>();

  const prepared = await mapConcurrent(all, 3, async (story) => {
    const accepted = normaliseStory(story);
    if (!accepted) return { status: 'rejected' as const };
    const verified = await verifyStory(accepted);
    if (!verified.length || !passesCategoryPolicy(accepted, verified)) {
      return { status: 'verification_failed' as const };
    }
    const grounded = await groundStory(accepted, verified);
    if (!grounded || !isFresh(accepted.category, grounded.published_at)) {
      return { status: 'verification_failed' as const };
    }
    return { status: 'ready' as const, accepted, verified, grounded };
  });

  for (const result of prepared) {
    if (result.status === 'rejected') {
      rejected++;
      continue;
    }
    if (result.status === 'verification_failed') {
      verificationFailed++;
      continue;
    }
    const { accepted, verified, grounded } = result;
    const canonicalUrl = canonicalizeUrl(accepted.sources[0]!.url);
    const related = findRelatedEvent(accepted, grounded, recentEvents);
    const eventKey = related?.eventKey ?? eventFingerprint(accepted.event_key || grounded.headline);
    if (seen.has(canonicalUrl) || seenEvents.has(eventKey)) continue;
    seen.add(canonicalUrl);
    seenEvents.add(eventKey);

    if (related) {
      const previousClaims = extractStoredClaims(related.evidence);
      if (!hasMaterialUpdate(previousClaims, grounded.claims)) continue;
      await db
        .update(stories)
        .set({
          title: grounded.headline.slice(0, 500),
          eventKey,
          revision: related.revision + 1,
          summary: truncateWords(grounded.summary, 180),
          topics: normaliseTopics(accepted.topics),
          credibilityScore: credibilityFor(accepted),
          publishedAt: parseDate(grounded.published_at),
          raw: { discovery: 'grok-web-x', category: accepted.category, sources: accepted.sources, image: accepted.image },
          evidence: { sources: verified.map(compactEvidence), claims: grounded.claims },
          updatedAt: new Date(),
        })
        .where(eq(stories.id, related.id));
      storyIds.push(related.id);
      related.title = grounded.headline;
      related.summary = grounded.summary;
      related.revision += 1;
      related.evidence = { sources: verified.map(compactEvidence), claims: grounded.claims };
      inserted++;
      continue;
    }

    const rows = await db
      .insert(stories)
      .values({
        sourceId,
        canonicalUrl,
        title: grounded.headline.slice(0, 500),
        eventKey,
        summary: truncateWords(grounded.summary, 180),
        topics: normaliseTopics(accepted.topics),
        credibilityScore: credibilityFor(accepted),
        publishedAt: parseDate(grounded.published_at),
        raw: {
          discovery: 'grok-web-x',
          category: accepted.category,
          sources: accepted.sources,
          image: accepted.image,
        },
        evidence: { sources: verified.map(compactEvidence), claims: grounded.claims },
      })
      .onConflictDoNothing({ target: stories.canonicalUrl })
      .returning({ id: stories.id });
    inserted += rows.length;
    storyIds.push(...rows.map((row) => row.id));
  }

  return { searched: searches.length, discovered: all.length, inserted, storyIds, rejected, verificationFailed, errors };
}

async function runSearch(query: string): Promise<ResearchStory[]> {
  const quietSignal = query.startsWith('QUIET SIGNAL PASS');
  const user = `CURRENT DATE: ${new Date().toISOString()}

RESEARCH ASSIGNMENT:
${query}

Return up to 10 genuinely consequential, non-duplicate events.`;
  const result = await callModel({
    role: 'research',
    system: SYSTEM,
    user,
    jsonSchema: { name: 'news_research', schema: ResearchResultSchema },
    maxTokens: 5000,
    temperature: 0.1,
    webSearch: {
      maxResults: quietSignal ? 10 : 7,
      searchContextSize: quietSignal ? 'high' : 'medium',
      excludeDomains: ['pinterest.com', 'quora.com', 'fandom.com', 'instagram.com', 'facebook.com'],
    },
  });
  const parsed = ResearchResultSchema.parse(JSON.parse(stripFences(result.content))).stories;
  const cited = new Set(result.citations.map((citation) => comparableUrl(citation.url)));
  return parsed
    .map((story) => ({
      ...story,
      sources: story.sources.filter((source) => cited.has(comparableUrl(source.url))),
    }))
    .filter((story) => story.sources.length > 0);
}

async function researchIsFresh(hours: number): Promise<boolean> {
  const source = await db.select({ id: sources.id }).from(sources).where(eq(sources.url, 'https://openrouter.ai/x-ai/grok-4.3')).limit(1);
  if (!source[0]) return false;
  const latest = await db
    .select({ at: stories.ingestedAt })
    .from(stories)
    .where(eq(stories.sourceId, source[0].id))
    .orderBy(desc(stories.ingestedAt))
    .limit(1);
  return Boolean(latest[0]?.at && latest[0].at.getTime() > Date.now() - hours * 3_600_000);
}

async function personalSearches(max: number, accountId?: string): Promise<string[]> {
  const conditions = [isNotNull(accounts.onboardedAt), isNotNull(userProfiles.personaSummary)];
  if (accountId) conditions.push(eq(accounts.id, accountId));
  const rows = await db
    .select({
      accountId: accounts.id,
      persona: userProfiles.personaSummary,
      context: userProfiles.contextDigest,
    })
    .from(accounts)
    .innerJoin(userProfiles, eq(userProfiles.accountId, accounts.id))
    .where(and(...conditions))
    .limit(max);

  const out: string[] = [];
  for (const row of rows) {
    await db.delete(interests).where(and(eq(interests.accountId, row.accountId), eq(interests.source, 'inferred')));
    const userInterests = await db
      .select({ label: interests.label, weight: interests.weight })
      .from(interests)
      .where(eq(interests.accountId, row.accountId));
    const positive = userInterests
      .filter((i) => i.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 12)
      .map((i) => i.label);
    if (!positive.length && !row.context) continue;
    const plan = await buildCoveragePlan({
      persona: row.persona ?? '',
      context: row.context ?? '',
      interests: userInterests,
    });
    const inferred = plan.beats.map((beat) => ({
      accountId: row.accountId,
      label: beat.label.toLowerCase().trim().slice(0, 40),
      kind: 'topic',
      weight: beat.priority,
      source: 'inferred',
    }));
    if (inferred.length) await db.insert(interests).values(inferred);
    const context = `Profile: ${(row.persona ?? '').slice(0, 1_500)}.`;
    const freshness =
      'The material event itself must fall inside the stated window. Reject old acquisitions, launches, announcements, or results merely resurfaced by a newly published article. Do not return generic sport, celebrity, or broad trending news unless explicitly tracked. Do not personalise the returned journalism.';
    for (const beat of plan.beats.sort((a, b) => b.priority - a.priority)) {
      out.push(
        `BEAT: ${beat.label}. Search independently for the strongest genuinely new development on this beat. Search terms and entities: ${beat.search_terms.join(', ')}. Why this is a beat: ${beat.rationale}. Search the last 72 hours for fast-moving news and up to 14 days for slower research, policy, pricing, standards, releases, collector-market changes, or official announcements. Resolve aliases and search specialist sources as well as the broad web and X. Return nothing if this beat has no meaningful new event. Exclusions: ${plan.exclusions.join(', ') || 'none'}. ${context} ${freshness}`,
      );
      if (beat.priority >= 2) {
        out.push(
          `QUIET SIGNAL PASS FOR BEAT: ${beat.label}. Find under-the-radar developments that are unlikely to be front-page news but are unusually relevant to this reader. Search terms and entities: ${beat.search_terms.join(', ')}. Specifically inspect official changelogs and release notes, company and creator posts, regulatory filings, standards bodies, research repositories, specialist trade publications, collector or market databases, credible niche newsletters, relevant forums and communities, GitHub or product activity, and authoritative X accounts. Look for small concrete changes, early primary signals, availability or pricing moves, roadmap clues, policy details, acquisitions or hires, unusual market activity, and specialist discoveries. Require a dated event inside the window and explain it as neutral news. Community or X material may surface the lead but cannot be the sole verification. Return nothing rather than generic commentary. Exclusions: ${plan.exclusions.join(', ') || 'none'}. Why this beat matters: ${beat.rationale}. ${context} ${freshness}`,
        );
      }
    }
  }
  return dedupeSearches(out).slice(0, max);
}

function normaliseStory(story: ResearchStory): ResearchStory | null {
  const sourcesClean = story.sources
    .filter((s) => isHttpUrl(s.url))
    .filter((s, i, arr) => arr.findIndex((x) => canonicalizeUrl(x.url) === canonicalizeUrl(s.url)) === i);
  const nonSocial = sourcesClean.filter((s) => !isSocialUrl(s.url));
  if (nonSocial.length === 0) return null;
  if (nonSocial.length === 1 && !isHighQualityUrl(nonSocial[0]!.url)) return null;

  const primary = nonSocial.find((s) => s.primary) ?? nonSocial[0]!;
  const ordered = [primary, ...sourcesClean.filter((s) => s.url !== primary.url)].slice(0, 5);
  return {
    ...story,
    headline: cleanText(story.headline),
    summary: cleanText(story.summary),
    sources: ordered,
    image: story.image && usefulImage(story.image.url) ? story.image : undefined,
  };
}

async function verifyStory(story: ResearchStory): Promise<VerifiedSource[]> {
  const importantTerms = eventTerms(story.headline);
  const checked = await Promise.all(story.sources.slice(0, 5).map((source) => verifySource(source, importantTerms)));
  return checked.filter((source): source is VerifiedSource => Boolean(source));
}

async function verifySource(source: ResearchStory['sources'][number], terms: string[]): Promise<VerifiedSource | null> {
  try {
    const response = await fetch(source.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
      headers: { 'user-agent': 'WinnowBot/0.1 (+https://winnow.to)' },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return null;
    const html = (await response.text()).slice(0, 350_000);
    const text = stripHtml(html);
    if (text.length < 300) return null;
    const lower = text.toLowerCase();
    const matches = terms.filter((term) => lower.includes(term)).length;
    if (matches < Math.min(2, terms.length)) return null;
    return {
      ...source,
      url: response.url || source.url,
      title: metaContent(html, 'og:title') ?? htmlTitle(html) ?? source.title,
      publishedAt: extractPublishedAt(html),
      text: text.slice(0, 18_000),
    };
  } catch {
    return null;
  }
}

async function groundStory(story: ResearchStory, sourcesVerified: VerifiedSource[]): Promise<GroundedStory | null> {
  const evidence = sourcesVerified
    .map((source, index) => `SOURCE ${index + 1}\nURL: ${source.url}\nPUBLISHED: ${source.publishedAt ?? 'unknown'}\nTEXT: ${source.text}`)
    .join('\n\n');
  try {
    const result = await callModel({
      role: 'bulk',
      system:
        'You are Winnow fact-checking desk. Write only from the supplied source extracts. Produce a neutral headline, a dense but clean 100-180 word summary, the best-supported publication time, and atomic claims. Every claim must cite one or more exact supplied URLs. Preserve important names, dates, numbers, caveats, and context. Omit anything unsupported. No personalisation, speculation, quotes over 12 words, or em dashes.',
      user: `PROPOSED STORY:\n${story.headline}\n${story.summary}\n\nVERIFIED SOURCE EXTRACTS:\n${evidence}`,
      jsonSchema: { name: 'grounded_story', schema: GroundedStorySchema },
      maxTokens: 1800,
      temperature: 0,
    });
    const grounded = GroundedStorySchema.parse(JSON.parse(stripFences(result.content)));
    const allowed = new Set(sourcesVerified.map((source) => comparableUrl(source.url)));
    if (grounded.claims.some((claim) => claim.source_urls.some((url) => !allowed.has(comparableUrl(url))))) return null;
    return grounded;
  } catch (error) {
    log.warn('news_grounding_failed', { headline: story.headline, error: (error as Error).message });
    return null;
  }
}

function passesCategoryPolicy(story: ResearchStory, verified: VerifiedSource[]): boolean {
  if (!verified.length) return false;
  const independentHosts = new Set(verified.filter((source) => !isSocialUrl(source.url)).map((source) => hostOf(source.url)));
  const hasOfficial = verified.some((source) => source.primary && (isOfficialUrl(source.url) || isFirstPartySource(source.url)));
  if (['politics', 'world', 'business', 'finance', 'health'].includes(story.category)) {
    return independentHosts.size >= 2 || hasOfficial;
  }
  if (story.category === 'science') {
    return verified.some((source) => isResearchSource(source.url)) || independentHosts.size >= 2;
  }
  if (story.category === 'sport') {
    return verified.some((source) => isOfficialSportSource(source.url)) || independentHosts.size >= 2;
  }
  if (story.category === 'technology') {
    return hasOfficial || independentHosts.size >= 2 || verified.some((source) => isHighQualityUrl(source.url));
  }
  return verified.some((source) => isHighQualityUrl(source.url)) || independentHosts.size >= 2;
}

function findRelatedEvent(
  story: ResearchStory,
  grounded: GroundedStory,
  recent: Array<typeof stories.$inferSelect>,
): (typeof stories.$inferSelect) | undefined {
  const target = tokenSet(`${story.event_key} ${grounded.headline} ${story.topics.join(' ')}`);
  let best: { row: typeof stories.$inferSelect; score: number } | undefined;
  for (const row of recent) {
    const candidate = tokenSet(`${row.eventKey ?? ''} ${row.title} ${(row.topics ?? []).join(' ')}`);
    const score = jaccard(target, candidate);
    if (score >= 0.42 && (!best || score > best.score)) best = { row, score };
  }
  return best?.row;
}

function hasMaterialUpdate(
  previous: Array<{ text: string; source_urls: string[] }>,
  next: Array<{ text: string; source_urls: string[] }>,
): boolean {
  if (!previous.length) return true;
  const oldText = previous.map((claim) => claim.text).join(' ');
  return next.some((claim) => {
    const overlap = jaccard(tokenSet(claim.text), tokenSet(oldText));
    const newNumber = (claim.text.match(/\b\d[\d,.%:-]*/g) ?? []).some((number) => !oldText.includes(number));
    return overlap < 0.55 || newNumber;
  });
}

function extractStoredClaims(evidence: unknown): Array<{ text: string; source_urls: string[] }> {
  if (!evidence || typeof evidence !== 'object') return [];
  const claims = (evidence as Record<string, unknown>).claims;
  if (!Array.isArray(claims)) return [];
  return claims.filter((claim): claim is { text: string; source_urls: string[] } => {
    if (!claim || typeof claim !== 'object') return false;
    const value = claim as Record<string, unknown>;
    return typeof value.text === 'string' && Array.isArray(value.source_urls);
  });
}

function compactEvidence(source: VerifiedSource): Omit<VerifiedSource, 'text'> & { excerpt: string } {
  const { text, ...rest } = source;
  return { ...rest, excerpt: text.slice(0, 1500) };
}

function isFresh(category: ResearchStory['category'], value: string): boolean {
  const date = parseDate(value);
  if (!date || date.getTime() > Date.now() + 3_600_000) return false;
  const maxDays = ['science', 'health'].includes(category) ? 14 : 4;
  return date.getTime() >= Date.now() - maxDays * 24 * 3_600_000;
}

function eventTerms(headline: string): string[] {
  return headline
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !['with', 'from', 'into', 'after', 'over', 'amid', 'says', 'announces'].includes(word))
    .slice(0, 8);
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ');
}

function htmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? stripHtml(match[1]!).trim() : null;
}

function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i'),
  ];
  return patterns.map((pattern) => pattern.exec(html)?.[1]).find(Boolean) ?? null;
}

function extractPublishedAt(html: string): string | null {
  const meta = ['article:published_time', 'datePublished', 'date', 'pubdate']
    .map((key) => metaContent(html, key))
    .find((value) => value && parseDate(value));
  if (meta) return new Date(meta).toISOString();
  const jsonLd = /"datePublished"\s*:\s*"([^"]+)"/i.exec(html)?.[1];
  if (jsonLd && parseDate(jsonLd)) return new Date(jsonLd).toISOString();
  const time = /<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1];
  return time && parseDate(time) ? new Date(time).toISOString() : null;
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isFirstPartySource(value: string): boolean {
  const host = hostOf(value);
  return /\.(com|org|io|ai|dev|co\.uk)$/.test(host) && !isHighQualityUrl(value) && !isSocialUrl(value);
}

function isResearchSource(value: string): boolean {
  const host = hostOf(value);
  return /(^|\.)((arxiv|doi)\.org|nature\.com|science\.org|thelancet\.com|nejm\.org)$/.test(host) || /\.ac\.uk$/.test(host) || /\.edu$/.test(host);
}

function isOfficialSportSource(value: string): boolean {
  const host = hostOf(value);
  return ['nba.com', 'nfl.com', 'nhl.com', 'mlb.com', 'fifa.com', 'uefa.com', 'premierleague.com', 'formula1.com'].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !['the', 'and', 'for', 'with', 'from', 'into', 'after', 'that', 'this'].includes(word)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function credibilityFor(story: ResearchStory): number {
  const nonSocial = story.sources.filter((s) => !isSocialUrl(s.url));
  const primary = nonSocial[0]?.url ?? '';
  const official = isOfficialUrl(primary);
  if (official && nonSocial.length >= 2) return 0.95;
  if (official) return 0.9;
  if (nonSocial.length >= 3 && nonSocial.every((source) => isHighQualityUrl(source.url))) return 0.88;
  if (nonSocial.length >= 2) return 0.8;
  return 0.65;
}

async function researchSourceId(): Promise<string> {
  const url = 'https://openrouter.ai/x-ai/grok-4.3';
  const existing = await db.select({ id: sources.id }).from(sources).where(eq(sources.url, url)).limit(1);
  if (existing[0]) return existing[0].id;
  const inserted = await db
    .insert(sources)
    .values({ name: 'Grok Web + X Research', kind: 'search', url, credibilityTier: 2, active: false })
    .returning({ id: sources.id });
  return inserted[0]!.id;
}

function dedupeSearches(searches: string[]): string[] {
  const seen = new Set<string>();
  return searches.filter((q) => {
    const key = q.toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normaliseTopics(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 10);
}

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/—/g, ',').trim();
}

function eventFingerprint(headline: string): string {
  return headline
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !['the', 'and', 'for', 'with', 'from', 'into', 'after'].includes(word))
    .sort()
    .slice(0, 12)
    .join(' ');
}

function truncateWords(value: string, max: number): string {
  const words = value.trim().split(/\s+/);
  return words.length <= max ? value.trim() : words.slice(0, max).join(' ');
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isSocialUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '');
    return host === 'x.com' || host === 'twitter.com' || host === 't.co';
  } catch {
    return true;
  }
}

function usefulImage(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !/(avatar|icon|logo|badge|emoji|tracking|pixel|spacer)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function comparableUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|campaign$|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    return `${url.hostname.replace(/^www\./, '').toLowerCase()}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function isOfficialUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '').toLowerCase();
    return host.endsWith('.gov') || host.endsWith('.gov.uk') || host.endsWith('.europa.eu') || host.endsWith('.int');
  } catch {
    return false;
  }
}

function isHighQualityUrl(value: string): boolean {
  if (isOfficialUrl(value)) return true;
  try {
    const host = new URL(value).hostname.replace(/^www\./, '').toLowerCase();
    return [
      'reuters.com',
      'apnews.com',
      'bbc.com',
      'bbc.co.uk',
      'ft.com',
      'bloomberg.com',
      'nytimes.com',
      'washingtonpost.com',
      'theguardian.com',
      'economist.com',
      'npr.org',
      'cnn.com',
      'cnbc.com',
      'wsj.com',
      'latimes.com',
      'nature.com',
      'science.org',
      'thelancet.com',
      'nejm.org',
      'espn.com',
      'nba.com',
      'techcrunch.com',
      'arstechnica.com',
      'theverge.com',
    ].some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function stripFences(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}
