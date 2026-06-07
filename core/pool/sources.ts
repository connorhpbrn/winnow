import { db } from '../../lib/db';
import { sources } from '../schema/tables';

// v1 seed source set (spec Section 9.1, a KNOB). Tech-leaning to match the early
// audience. Tiers: 1 = official/primary, 2 = reputable, 3 = aggregator/social.
// GitHub release atoms are genuine tier-1 primary sources ("what changed" = versions).
// Official vendor blogs with reliable public RSS can be added here as a KNOB.
export interface SeedSource {
  name: string;
  kind: 'rss' | 'hn' | 'github_releases' | 'blog' | 'changelog';
  url: string;
  credibilityTier: number;
}

export const SEED_SOURCES: SeedSource[] = [
  // Tier 1: official/primary release notes.
  { name: 'Next.js Releases', kind: 'github_releases', url: 'https://github.com/vercel/next.js/releases.atom', credibilityTier: 1 },
  { name: 'React Releases', kind: 'github_releases', url: 'https://github.com/facebook/react/releases.atom', credibilityTier: 1 },
  { name: 'TypeScript Releases', kind: 'github_releases', url: 'https://github.com/microsoft/TypeScript/releases.atom', credibilityTier: 1 },
  { name: 'Ollama Releases', kind: 'github_releases', url: 'https://github.com/ollama/ollama/releases.atom', credibilityTier: 1 },

  // Tier 2: reputable.
  { name: 'Hacker News Front Page', kind: 'hn', url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40', credibilityTier: 2 },
  { name: "Simon Willison's Weblog", kind: 'blog', url: 'https://simonwillison.net/atom/everything/', credibilityTier: 2 },
  { name: 'Ars Technica', kind: 'rss', url: 'https://feeds.arstechnica.com/arstechnica/index', credibilityTier: 2 },

  // Tier 3: aggregator/social.
  { name: 'The Verge', kind: 'rss', url: 'https://www.theverge.com/rss/index.xml', credibilityTier: 3 },
  { name: 'Hacker News New', kind: 'hn', url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=40', credibilityTier: 3 },
];

/** Idempotently insert any seed sources not already present (matched by url). */
export async function seedSources(): Promise<{ added: number; total: number }> {
  const existing = await db.select({ url: sources.url }).from(sources);
  const have = new Set(existing.map((e) => e.url));
  const toAdd = SEED_SOURCES.filter((s) => !have.has(s.url));
  if (toAdd.length) await db.insert(sources).values(toAdd);
  return { added: toAdd.length, total: existing.length + toAdd.length };
}
