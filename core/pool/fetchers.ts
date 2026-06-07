import Parser from 'rss-parser';

// Normalised feed item. `raw` carries the original for re-derivation / summarisation input.
export interface RawItem {
  title: string;
  url: string;
  publishedAt: Date | null;
  snippet: string;
  image?: { url: string; alt?: string; credit?: string };
  raw: unknown;
}

const parser = new Parser({ timeout: 15_000 });

export async function fetchSource(source: { kind: string; url: string }): Promise<RawItem[]> {
  if (source.kind === 'hn') return fetchHN(source.url);
  // rss | blog | changelog | github_releases (atom) are all parseable by rss-parser.
  return fetchFeed(source.url);
}

async function fetchFeed(url: string): Promise<RawItem[]> {
  const feed = await parser.parseURL(url);
  return (feed.items ?? [])
    .map((it) => {
      const snippet = String(it.contentSnippet ?? it.content ?? (it as { summary?: string }).summary ?? '').slice(0, 1200);
      const dateStr = it.isoDate ?? it.pubDate;
      const image = extractFeedImage(it);
      return {
        title: String(it.title ?? '').trim(),
        url: String(it.link ?? '').trim(),
        publishedAt: dateStr ? new Date(dateStr) : null,
        snippet,
        image,
        raw: it,
      } satisfies RawItem;
    })
    .filter((i) => i.title && i.url);
}

function extractFeedImage(item: unknown): RawItem['image'] {
  if (!item || typeof item !== 'object') return undefined;
  const it = item as Record<string, unknown>;
  const candidates = [
    readUrl(it.enclosure),
    readUrl(it['media:content']),
    readUrl(it['media:thumbnail']),
    readUrl(it.image),
    imageFromHtml(String(it.content ?? it.summary ?? '')),
  ];
  const url = candidates.find(isUsefulImageUrl);
  if (!url) return undefined;
  return { url, alt: String(it.title ?? '').trim() || undefined };
}

function readUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.url === 'string') return obj.url;
  if (typeof obj.href === 'string') return obj.href;
  if (typeof obj.$ === 'object' && obj.$) return readUrl(obj.$);
  return undefined;
}

function imageFromHtml(html: string): string | undefined {
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return match?.[1];
}

function isUsefulImageUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return !/(avatar|icon|logo|badge|emoji|tracking|pixel|spacer)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

interface HNHit {
  title?: string;
  url?: string;
  objectID: string;
  created_at?: string;
  story_text?: string;
  points?: number;
  num_comments?: number;
}

async function fetchHN(url: string): Promise<RawItem[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HN fetch failed: ${res.status}`);
  const data = (await res.json()) as { hits?: HNHit[] };
  return (data.hits ?? [])
    .map((h) => {
      const url = (h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`).trim();
      const meta = [h.points ? `${h.points} points` : '', h.num_comments ? `${h.num_comments} comments` : '']
        .filter(Boolean)
        .join(', ');
      return {
        title: String(h.title ?? '').trim(),
        url,
        publishedAt: h.created_at ? new Date(h.created_at) : null,
        snippet: String(h.story_text ?? (meta ? `Hacker News discussion (${meta}).` : 'Hacker News discussion.')).slice(0, 1200),
        raw: h,
      } satisfies RawItem;
    })
    .filter((i) => i.title && i.url);
}
