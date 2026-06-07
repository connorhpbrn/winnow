import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '../../lib/db';
import { usageDaily, interests, generationLocks } from '../schema/tables';
import type { AccountId } from '../schema/domain';

// Backend limits (spec Section 16). Users never see "credits". On hit we return a
// reassuring message (Section 12.5), not a hard paywall.
const LIMITS = { brief: 1, follow_up: 10, deep_dive: 3 } as const;
export type LimitKind = keyof typeof LIMITS;

const INTEREST_CAP = 25; // positive-weight interests
const LOCK_STALE = "interval '10 minutes'"; // dead-lock escape hatch

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  message?: string;
}

// Counter day is keyed in UTC.
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

const PROP: Record<LimitKind, 'briefs' | 'followUps' | 'deepDives'> = {
  brief: 'briefs',
  follow_up: 'followUps',
  deep_dive: 'deepDives',
};

function limitMessage(kind: LimitKind): string {
  switch (kind) {
    case 'deep_dive':
      return "You've hit today's deep research limit. I can still answer from cached sources, and your next brief runs as normal.";
    case 'follow_up':
      return "You've reached today's follow-up limit. I can still answer from what I've already gathered, and your next brief runs as normal.";
    case 'brief':
      return "You've already generated today's paper. Use /paper to explicitly request a fresh one.";
  }
}

/** Read-only check. Does NOT increment. */
export async function checkLimit(accountId: AccountId, kind: LimitKind): Promise<LimitResult> {
  const rows = await db
    .select()
    .from(usageDaily)
    .where(and(eq(usageDaily.accountId, accountId), eq(usageDaily.day, todayUtc())))
    .limit(1);
  const current = rows[0] ? rows[0][PROP[kind]] : 0;
  const cap = LIMITS[kind];
  const allowed = current < cap;
  return { allowed, remaining: Math.max(0, cap - current), message: allowed ? undefined : limitMessage(kind) };
}

const VALUES_ONE = {
  brief: { briefs: 1 },
  follow_up: { followUps: 1 },
  deep_dive: { deepDives: 1 },
} as const;

const SET_INCREMENT = {
  brief: () => ({ briefs: sql`${usageDaily.briefs} + 1` }),
  follow_up: () => ({ followUps: sql`${usageDaily.followUps} + 1` }),
  deep_dive: () => ({ deepDives: sql`${usageDaily.deepDives} + 1` }),
} as const;

/** Atomic increment of the day's counter (upsert). */
export async function consumeLimit(accountId: AccountId, kind: LimitKind): Promise<void> {
  await db
    .insert(usageDaily)
    .values({ accountId, day: todayUtc(), ...VALUES_ONE[kind] })
    .onConflictDoUpdate({
      target: [usageDaily.accountId, usageDaily.day],
      set: SET_INCREMENT[kind](),
    });
}

/** Check, and if allowed, consume in one call. For immediate actions (follow-ups, deep dives). */
export async function checkAndConsume(accountId: AccountId, kind: LimitKind): Promise<LimitResult> {
  const check = await checkLimit(accountId, kind);
  if (!check.allowed) return check;
  await consumeLimit(accountId, kind);
  return { allowed: true, remaining: Math.max(0, check.remaining - 1) };
}

export async function checkInterestCap(
  accountId: AccountId,
): Promise<{ allowed: boolean; current: number; max: number }> {
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(interests)
    .where(and(eq(interests.accountId, accountId), gt(interests.weight, 0)));
  const current = Number(rows[0]?.c ?? 0);
  return { allowed: current < INTEREST_CAP, current, max: INTEREST_CAP };
}

/**
 * One active generation per account (spec Section 15/16). Atomic: inserts the lock, or
 * STEALS it if the existing lock's locked_at is older than 10 minutes (a crashed run must
 * never wedge an account permanently). Returns false only when a fresh lock is held.
 */
export async function acquireGenerationLock(accountId: AccountId, job: string): Promise<boolean> {
  const rows = await db
    .insert(generationLocks)
    .values({ accountId, lockedAt: new Date(), job })
    .onConflictDoUpdate({
      target: generationLocks.accountId,
      set: { lockedAt: sql`now()`, job: sql`excluded.job` },
      setWhere: sql`${generationLocks.lockedAt} < now() - ${sql.raw(LOCK_STALE)}`,
    })
    .returning({ accountId: generationLocks.accountId });
  return rows.length > 0;
}

export async function releaseGenerationLock(accountId: AccountId): Promise<void> {
  await db.delete(generationLocks).where(eq(generationLocks.accountId, accountId));
}
