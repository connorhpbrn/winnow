import { nanoid } from 'nanoid';
import { db } from '../../lib/db';
import { briefs, seenStories } from '../schema/tables';
import { log } from '../../lib/log';
import {
  acquireGenerationLock,
  releaseGenerationLock,
  checkLimit,
  consumeLimit,
} from '../limits/limits';
import { getProfile, getInterests } from '../memory/profile';
import { getContextDigest } from '../memory/context';
import { syncAllConnections } from '../mcp';
import { discoverNews } from '../pool/discover';
import { selectCandidates, type Candidate } from '../ranking/prefilter';
import { composeBrief } from './compose';
import type { Brief } from '../schema/brief';
import type { AccountId, BriefId } from '../schema/domain';

export interface GenerationLog {
  accountId: string;
  reason: string;
  editionDate: string;
  candidateCount: number;
  candidates: Array<{ id: string; title: string; score: number; matched: string[]; outside: boolean }>;
  selectedItemIds: string[];
  cutCandidateIds: string[];
  quiet: boolean;
  repaired: boolean;
  itemsCount: number;
  usage?: { promptTokens: number; completionTokens: number; costUsd: number; latencyMs: number };
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export type GenerateBriefResult =
  | { ok: true; briefId: BriefId; publicId: string; brief: Brief; log: GenerationLog }
  | {
      ok: false;
      reason: 'validation_failed' | 'model_error' | 'locked' | 'limit_reached';
      log: GenerationLog;
    };

const MAX_ITEMS = 5; // KNOB (spec Section 21)
const EXPIRY_MS = 7 * 24 * 3_600_000;

/**
 * The headline orchestration (spec Section 10.2 + 10.3). Acquire lock -> check brief limit ->
 * pre-filter -> compose -> validate -> ONE repair retry -> persist briefs (+ debug log) +
 * seen_stories -> CONSUME the brief limit -> release lock (finally). Returns the brief; does
 * NOT send (the caller does). A thin/empty candidate set yields a deterministic quiet brief.
 * A failed generation never consumes the user's 1/day.
 */
export async function generateBrief(
  accountId: AccountId,
  opts?: { reason?: 'onboarding' | 'manual' },
): Promise<GenerateBriefResult> {
  const reason = opts?.reason ?? 'manual';
  const startedAt = new Date().toISOString();

  const acquired = await acquireGenerationLock(accountId, `generateBrief:${reason}`);
  if (!acquired) {
    return { ok: false, reason: 'locked', log: emptyLog(accountId, reason, startedAt, 'lock held') };
  }

  try {
    const limit = await checkLimit(accountId, 'brief');
    if (!limit.allowed) {
      return { ok: false, reason: 'limit_reached', log: emptyLog(accountId, reason, startedAt, 'limit reached') };
    }

    const profile = await getProfile(accountId);
    const interests = await getInterests(accountId);
    const editionDate = computeEditionDate(profile?.timezone ?? 'UTC');

    // First and manually requested papers should be based on a fresh search for this
    // person, not whatever happens to be sitting in the shared pool.
    try {
      await syncAllConnections(accountId);
    } catch (e) {
      log.warn('mcp_sync_failed', { accountId, error: (e as Error).message });
    }
    const contextDigest = await getContextDigest(accountId);
    const discovery = await discoverNews({
      accountId,
      personalOnly: true,
      force: true,
      maxPersonalSearches: 12,
    });
    log.info('personal_news_discovery', { accountId, reason, ...discovery });
    const candidates = await selectCandidates(accountId, { storyIds: discovery.storyIds });

    let brief: Brief;
    let repaired = false;
    let usage: GenerationLog['usage'];

    if (candidates.length === 0) {
      brief = quietBrief(editionDate); // deterministic, no model call
    } else {
      const composeInput = {
        personaSummary: profile?.personaSummary ?? '',
        interests: interests.map((i) => ({ label: i.label, kind: i.kind, weight: i.weight })),
        writingStyle: profile?.writingStyle ?? 'balanced',
        candidates,
        editionDate,
        contextDigest,
      };

      let result = await composeBrief(composeInput);
      usage = accumulate(usage, result.usage);

      if (!result.ok) {
        repaired = true;
        const retry = await composeBrief({ ...composeInput, repairHint: { rawOutput: result.rawOutput, zodError: result.zodError } });
        usage = accumulate(usage, retry.usage);
        if (!retry.ok) {
          log.error('brief_validation_failed', { accountId, zodError: retry.zodError });
          return {
            ok: false,
            reason: 'validation_failed',
            log: { ...buildLog(accountId, reason, editionDate, candidates, [], true, startedAt, usage), error: retry.zodError },
          };
        }
        result = retry;
      }
      brief = result.brief;
    }

    brief.items = brief.items.slice(0, MAX_ITEMS);
    const candidatesById = new Map(candidates.map((candidate) => [candidate.card.id, candidate.card]));
    brief.items = brief.items.map((item) => ({
      ...item,
      is_update: candidatesById.get(item.id)?.isUpdate || undefined,
    }));

    const publicId = nanoid(21);
    const candidateIds = new Set(candidates.map((c) => c.card.id));
    const selectedItemIds = brief.items.map((i) => i.id);
    const generationLog: GenerationLog = {
      ...buildLog(accountId, reason, editionDate, candidates, selectedItemIds, repaired, startedAt, usage),
      quiet: brief.items.length === 0,
      itemsCount: brief.items.length,
    };

    const inserted = await db
      .insert(briefs)
      .values({
        accountId,
        publicId,
        editionDate,
        payload: brief,
        debug: generationLog,
        expiresAt: new Date(Date.now() + EXPIRY_MS),
      })
      .returning({ id: briefs.id });
    const briefId = inserted[0]!.id;

    // Record seen_stories only for items that map to real candidates (prevents repeats).
    const seenRows = selectedItemIds
      .filter((id) => candidateIds.has(id))
      .map((id) => ({ accountId, storyId: id, revision: candidatesById.get(id)?.revision ?? 1, briefId }));
    if (seenRows.length) await db.insert(seenStories).values(seenRows).onConflictDoNothing();

    // Consume the daily limit ONLY after a brief was successfully written.
    await consumeLimit(accountId, 'brief');

    return { ok: true, briefId, publicId, brief, log: generationLog };
  } catch (e) {
    const message = (e as Error).message;
    log.error('brief_generation_error', { accountId, error: message });
    return {
      ok: false,
      reason: 'model_error',
      log: { ...emptyLog(accountId, reason, startedAt, message), error: message },
    };
  } finally {
    await releaseGenerationLock(accountId);
  }
}

function quietBrief(editionDate: string): Brief {
  return {
    edition_date: editionDate,
    greeting: greetingFor(editionDate),
    items: [],
    quiet_note:
      'Genuinely quiet cycle. Nothing in your tracked areas changed in a way that matters to you. I would rather send you this than manufacture signal, so I will keep watching and bring you the next thing that actually moves.',
  };
}

function computeEditionDate(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function greetingFor(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const day = d.getUTCDate();
  const month = d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return `Brief, ${day} ${month}`;
}

function accumulate(
  acc: GenerationLog['usage'],
  u: { promptTokens: number; completionTokens: number; costUsd: number; latencyMs: number },
): GenerationLog['usage'] {
  if (!acc) return { promptTokens: u.promptTokens, completionTokens: u.completionTokens, costUsd: u.costUsd, latencyMs: u.latencyMs };
  return {
    promptTokens: acc.promptTokens + u.promptTokens,
    completionTokens: acc.completionTokens + u.completionTokens,
    costUsd: Math.round((acc.costUsd + u.costUsd) * 1e6) / 1e6,
    latencyMs: acc.latencyMs + u.latencyMs,
  };
}

function buildLog(
  accountId: string,
  reason: string,
  editionDate: string,
  candidates: Candidate[],
  selectedItemIds: string[],
  repaired: boolean,
  startedAt: string,
  usage: GenerationLog['usage'],
): GenerationLog {
  const selected = new Set(selectedItemIds);
  return {
    accountId,
    reason,
    editionDate,
    candidateCount: candidates.length,
    candidates: candidates.map((c) => ({
      id: c.card.id,
      title: c.card.title,
      score: c.prefilterScore,
      matched: c.matchedInterests.map((m) => m.label),
      outside: c.outsideInterests,
    })),
    selectedItemIds,
    cutCandidateIds: candidates.map((c) => c.card.id).filter((id) => !selected.has(id)),
    quiet: selectedItemIds.length === 0,
    repaired,
    itemsCount: selectedItemIds.length,
    usage,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function emptyLog(accountId: string, reason: string, startedAt: string, note: string): GenerationLog {
  return {
    accountId,
    reason,
    editionDate: '',
    candidateCount: 0,
    candidates: [],
    selectedItemIds: [],
    cutCandidateIds: [],
    quiet: false,
    repaired: false,
    itemsCount: 0,
    error: note,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
