import { eq } from 'drizzle-orm';
import { db } from '../../lib/db';
import { seenStories } from '../schema/tables';
import { listRecentStories } from '../pool';
import type { StoryCard } from '../pool/storyCard';
import { getInterests } from '../memory/profile';
import type { AccountId } from '../schema/domain';

// Stage 1 (spec Section 10.1): cheap, deterministic, NO model calls. Turns the shared pool
// into a per-user candidate set by recency + interest match + credibility, with a small
// high-tier allowance so the brief is not a pure echo chamber.

export interface Candidate {
  card: StoryCard;
  prefilterScore: number;
  matchedInterests: Array<{ label: string; weight: number }>;
  outsideInterests: boolean;
}

export interface WeightedLabel {
  label: string;
  weight: number;
}

const DEFAULT_WINDOW_HOURS = 48; // KNOB (spec Section 21)
const DEFAULT_MAX = 20;
const RESERVE_OUTSIDE = 1; // one exceptional outside-interest story, never generic padding
const OUTSIDE_CATEGORIES = new Set(['world', 'politics', 'business', 'finance', 'science', 'health', 'technology']);

interface Scored {
  card: StoryCard;
  score: number;
  matched: Array<{ label: string; weight: number }>;
  outside: boolean;
  excluded: boolean;
}

/** Collapse all interest rows (onboarding + feedback + inferred) into net weight per label. */
export function effectiveInterests(rows: Array<{ label: string; weight: number }>): {
  positive: WeightedLabel[];
  negative: WeightedLabel[];
} {
  const byLabel = new Map<string, number>();
  for (const r of rows) {
    const label = r.label.toLowerCase().trim();
    if (!label) continue;
    byLabel.set(label, (byLabel.get(label) ?? 0) + r.weight);
  }
  const positive: WeightedLabel[] = [];
  const negative: WeightedLabel[] = [];
  for (const [label, weight] of byLabel) {
    if (weight > 0) positive.push({ label, weight });
    else if (weight < 0) negative.push({ label, weight });
  }
  return { positive, negative };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelMatches(label: string, card: StoryCard): boolean {
  const re = new RegExp(`\\b${escapeRegex(label)}\\b`, 'i');
  if (card.topics.some((t) => t === label || re.test(t))) return true;
  return re.test(card.title) || re.test(card.summary);
}

function recencyScore(card: StoryCard, windowHours: number): number {
  const ts = card.publishedAt ?? card.ingestedAt;
  const ageHours = (Date.now() - new Date(ts).getTime()) / 3_600_000;
  return Math.max(0, Math.min(1, 1 - ageHours / windowHours));
}

/**
 * Pure scoring of a single card against a user's interests. Exported for unit testing.
 * Returns excluded=true when an ignore-list label dominates.
 */
export function scoreCandidate(
  card: StoryCard,
  positive: WeightedLabel[],
  negative: WeightedLabel[],
  windowHours: number,
): Scored {
  const matched = positive.filter((p) => labelMatches(p.label, card)).map((p) => ({ label: p.label, weight: p.weight }));
  const matchScore = matched.reduce((s, m) => s + m.weight, 0);

  const negMatched = negative.filter((n) => labelMatches(n.label, card));
  const negScore = negMatched.reduce((s, n) => s + Math.abs(n.weight), 0);

  // Ignore wins when it outweighs any positive interest in the story.
  const excluded = negScore > 0 && matchScore < negScore;

  const cred = card.credibilityScore ?? 0.5;
  const rec = recencyScore(card, windowHours);
  const score = matchScore * 1.0 + cred * 1.5 + rec * 1.0 - negScore * 2.0;

  return { card, score, matched, outside: matched.length === 0, excluded };
}

export async function selectCandidates(
  accountId: AccountId,
  opts?: { window?: { sinceHours: number }; max?: number; storyIds?: string[] },
): Promise<Candidate[]> {
  const windowHours = opts?.window?.sinceHours ?? DEFAULT_WINDOW_HOURS;
  const max = opts?.max ?? DEFAULT_MAX;

  const interestRows = await getInterests(accountId);
  const { positive, negative } = effectiveInterests(interestRows);

  const seenRows = await db
    .select({ id: seenStories.storyId, revision: seenStories.revision })
    .from(seenStories)
    .where(eq(seenStories.accountId, accountId));
  const seen = new Set(seenRows.map((s) => `${s.id}:${s.revision}`));

  const pool = await listRecentStories({ sinceHours: windowHours, summarisedOnly: true, limit: 500 });
  const allowed = opts?.storyIds ? new Set(opts.storyIds) : null;
  const scored = pool
    .filter((card) => !allowed || allowed.has(card.id))
    .filter((c) => !seen.has(`${c.id}:${c.revision}`))
    .map((c) => scoreCandidate(c, positive, negative, windowHours))
    .filter((s) => !s.excluded);

  // Matched stories ranked by score; a few high-tier "outside" stories reserved for diversity.
  const matched = scored.filter((s) => !s.outside).sort((a, b) => b.score - a.score);
  const outside = scored
    .filter(
      (s) =>
        s.outside &&
        s.card.credibilityTier <= 2 &&
        (s.card.credibilityScore ?? 0) >= 0.85 &&
        (!s.card.category || OUTSIDE_CATEGORIES.has(s.card.category)),
    )
    .sort((a, b) => (b.card.credibilityScore ?? 0) - (a.card.credibilityScore ?? 0) || b.score - a.score);

  const reserve = Math.min(RESERVE_OUTSIDE, outside.length);
  const chosen: Scored[] = [...matched.slice(0, Math.max(0, max - reserve)), ...outside.slice(0, reserve)];

  // With no positive profile yet, use the best general stories. Once interests exist,
  // a short edition is preferable to filling it with unrelated pool inventory.
  if (chosen.length < max && positive.length === 0) {
    const taken = new Set(chosen.map((s) => s.card.id));
    const rest = scored.filter((s) => !taken.has(s.card.id)).sort((a, b) => b.score - a.score);
    chosen.push(...rest.slice(0, max - chosen.length));
  }

  return chosen.slice(0, max).map((s) => ({
    card: s.card,
    prefilterScore: Math.round(s.score * 100) / 100,
    matchedInterests: s.matched,
    outsideInterests: s.outside,
  }));
}
