import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { db, closeDb } from '../lib/db';
import { accounts, generationLocks, usageDaily } from '../core/schema/tables';
import { parseBrief } from '../core/schema/brief';
import { renderEditionHtml } from '../lib/edition/render';
import { canonicalizeUrl } from '../core/pool/canonical';
import { scoreCredibility, type StoryCard } from '../core/pool/storyCard';
import { effectiveInterests, scoreCandidate } from '../core/ranking/prefilter';
import { checkLimit, consumeLimit, checkAndConsume, acquireGenerationLock, releaseGenerationLock } from '../core/limits/limits';
import { generateBrief } from '../core/agent';

after(async () => {
  await closeDb();
});

// ---------- pure logic (no DB / no model) ----------

test('parseBrief rejects malformed JSON and bad shapes, accepts valid', () => {
  assert.equal(parseBrief('{not json').ok, false);
  assert.equal(parseBrief(JSON.stringify({ edition_date: '2026-06-07', greeting: 'hi', items: [] })).ok, true);
  // sources must have at least one entry
  const noSources = JSON.stringify({
    edition_date: 'x',
    greeting: 'g',
    items: [{ id: '1', headline: 'h', what_changed: 'w', why_it_matters: 'y', signal_quality: 'high', signal_note: 'n', action: 'a', matters_to_you: true, sources: [] }],
  });
  assert.equal(parseBrief(noSources).ok, false);
});

test('edition renders editorial copy and useful images, with legacy fallback', () => {
  const html = renderEditionHtml({
    edition_date: '2026-06-14',
    greeting: 'Brief',
    items: [
      {
        id: '1',
        headline: 'A useful release',
        what_changed: 'The release shipped.',
        why_it_matters: 'It changes the user workflow.',
        editorial_summary: 'The release shipped and changes the user workflow without adding setup.',
        watch_next: 'Watch the first stable patch.',
        signal_quality: 'high',
        signal_note: 'Primary source.',
        action: 'Review it.',
        matters_to_you: true,
        image: { url: 'https://example.com/product-shot.jpg', alt: 'The updated product interface.' },
        sources: [{ title: 'Release', url: 'https://example.com/release' }],
      },
      {
        id: '2',
        headline: 'Legacy item',
        what_changed: 'A change happened.',
        why_it_matters: 'It affects the current project.',
        signal_quality: 'medium',
        signal_note: 'Reputable source.',
        action: 'No action.',
        matters_to_you: true,
        sources: [{ title: 'Source', url: 'https://example.com/source' }],
      },
    ],
  });
  assert.match(html, /changes the user workflow without adding setup/);
  assert.doesNotMatch(html, /What to watch/);
  assert.match(html, /product-shot\.jpg/);
  assert.match(html, /A change happened\. It affects the current project\./);
});

test('canonicalizeUrl strips tracking params, www, fragment, trailing slash; forces https', () => {
  assert.equal(canonicalizeUrl('https://www.Example.com/a/?utm_source=x&id=5#frag'), 'https://example.com/a?id=5');
  assert.equal(canonicalizeUrl('http://example.com/a/'), 'https://example.com/a');
});

test('scoreCredibility orders by tier', () => {
  assert.ok(scoreCredibility({ sourceTier: 1 }) > scoreCredibility({ sourceTier: 2 }));
  assert.ok(scoreCredibility({ sourceTier: 2 }) > scoreCredibility({ sourceTier: 3 }));
});

test('effectiveInterests sums weights per label into positive/negative', () => {
  const { positive, negative } = effectiveInterests([
    { label: 'ai', weight: 2 },
    { label: 'AI', weight: 1 },
    { label: 'crypto', weight: -3 },
  ]);
  assert.equal(positive.find((p) => p.label === 'ai')?.weight, 3);
  assert.equal(negative.find((n) => n.label === 'crypto')?.weight, -3);
});

function card(over: Partial<StoryCard>): StoryCard {
  return {
    id: 'x',
    canonicalUrl: 'https://e.com',
    title: 't',
    summary: 's',
    topics: [],
    credibilityScore: 0.6,
    credibilityTier: 2,
    publishedAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    sourceName: 'src',
    sourceRefs: [{ title: 'src', url: 'https://e.com', publisher: 'src' }],
    eventKey: null,
    revision: 1,
    isUpdate: false,
    claims: [],
    ...over,
  };
}

test('scoreCandidate: positive match, ignore-dominates exclusion, outside-interest', () => {
  const matched = scoreCandidate(card({ topics: ['next.js'], title: 'Next.js 16 ships' }), [{ label: 'next.js', weight: 2 }], [], 48);
  assert.equal(matched.outside, false);
  assert.deepEqual(matched.matched.map((m) => m.label), ['next.js']);

  const excluded = scoreCandidate(card({ topics: ['crypto'], title: 'Crypto rally' }), [], [{ label: 'crypto', weight: -3 }], 48);
  assert.equal(excluded.excluded, true);

  const outside = scoreCandidate(card({ topics: ['gardening'], title: 'Tomatoes' }), [{ label: 'next.js', weight: 2 }], [], 48);
  assert.equal(outside.outside, true);
  assert.equal(outside.excluded, false);
});

// ---------- DB-backed: limits + lock (the user-requested guarantees) ----------

async function freshAccount(): Promise<string> {
  const inserted = await db.insert(accounts).values({ subscriptionStatus: 'active' }).returning({ id: accounts.id });
  return inserted[0]!.id;
}

test('consumeLimit increments; checkLimit blocks at cap with a reassuring message', async () => {
  const id = await freshAccount();
  assert.equal((await checkLimit(id, 'brief')).allowed, true);
  await consumeLimit(id, 'brief');
  const blocked = await checkLimit(id, 'brief');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.message && blocked.message.length > 0);
});

test('deep dive allows 3 per day then blocks', async () => {
  const id = await freshAccount();
  for (let i = 0; i < 3; i++) assert.equal((await checkAndConsume(id, 'deep_dive')).allowed, true);
  assert.equal((await checkAndConsume(id, 'deep_dive')).allowed, false);
});

test('generation lock: fresh lock is exclusive, but a lock older than 10 min is stolen', async () => {
  const id = await freshAccount();
  assert.equal(await acquireGenerationLock(id, 'first'), true);
  assert.equal(await acquireGenerationLock(id, 'second'), false); // fresh lock held
  await db.update(generationLocks).set({ lockedAt: sql`now() - interval '11 minutes'` }).where(eq(generationLocks.accountId, id));
  assert.equal(await acquireGenerationLock(id, 'stealer'), true); // stale lock stolen
  await releaseGenerationLock(id);
});

test('a failed generation (lock held) does NOT consume the daily brief count', async () => {
  const id = await freshAccount();
  await acquireGenerationLock(id, 'external-hold'); // simulate an in-flight generation
  const res = await generateBrief(id, { reason: 'manual' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'locked');
  const usage = await db.select().from(usageDaily).where(eq(usageDaily.accountId, id));
  assert.equal(usage[0]?.briefs ?? 0, 0); // failure did not burn the 1/day
  await releaseGenerationLock(id);
});
