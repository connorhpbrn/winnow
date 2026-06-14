import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../lib/db';
import { userProfiles, interests, type UserProfile, type Interest } from '../schema/tables';
import { callModel } from '../models/client';
import { hasOpenRouterKey } from '../../lib/env';
import { log } from '../../lib/log';
import type { AccountId } from '../schema/domain';

export interface RawAnswers {
  bioRaw: string;
  workingOnRaw: string;
  trackRaw: string;
  ignoreRaw: string;
  contextRaw?: string;
}

export interface DerivedInterest {
  label: string;
  kind: string;
  weight: number;
}
export interface DerivedProfile {
  personaSummary: string;
  interests: DerivedInterest[];
}

const DerivedSchema = z.object({
  personaSummary: z.string(),
  interests: z
    .array(z.object({ label: z.string(), kind: z.string(), weight: z.number() }))
    .default([]),
});

/**
 * Onboarding extraction (spec Section 7.4). Stores raw answers verbatim regardless of
 * extraction quality, then derives persona_summary + an initial interests set. Uses the
 * reasoning model when a key is present; otherwise a deterministic fallback so the rest of
 * the pipeline (ranking) is exercisable without a key.
 */
export async function deriveProfile(accountId: AccountId, input: RawAnswers): Promise<DerivedProfile> {
  // 1. Persist raw answers verbatim (source of truth).
  await db
    .insert(userProfiles)
    .values({ accountId, bioRaw: input.bioRaw, workingOnRaw: input.workingOnRaw })
    .onConflictDoUpdate({
      target: userProfiles.accountId,
      set: { bioRaw: input.bioRaw, workingOnRaw: input.workingOnRaw, updatedAt: new Date() },
    });

  // 2. Derive persona + interests.
  const derived = hasOpenRouterKey() ? await modelDerive(input) : fallbackDerive(input);

  // 3. Persist persona and replace the onboarding interest set (idempotent re-seed).
  await db.update(userProfiles).set({ personaSummary: derived.personaSummary, updatedAt: new Date() }).where(eq(userProfiles.accountId, accountId));
  await db.delete(interests).where(and(eq(interests.accountId, accountId), eq(interests.source, 'onboarding')));
  const rows = derived.interests
    .filter((i) => i.label.trim())
    .map((i) => ({ accountId, label: i.label.toLowerCase().trim(), kind: i.kind || 'topic', weight: i.weight, source: 'onboarding' }));
  if (rows.length) await db.insert(interests).values(rows);

  return derived;
}

async function modelDerive(input: RawAnswers): Promise<DerivedProfile> {
  const system =
    'Build a high-fidelity editorial profile from a user\'s onboarding answers and supplied context. Return JSON {"personaSummary": string, "interests": [{"label": string, "kind": string, "weight": number}]}. personaSummary: 4 to 7 dense sentences in third person. Preserve their role, active work, products, goals, sectors, tools, locations, constraints, priorities, taste, and explicit dislikes when present. Distinguish active projects from parked ideas. interests: extract concrete topics, entities, companies, people, products, technologies, locations, regulations, competitors, and recurring themes from ALL fields, not only the explicit track list. Use positive weight 1 to 3 based on importance and negative weight -1 to -3 for explicit ignores or dislikes. Do not infer enthusiasm from incidental mentions. kind is one of topic, entity, company, person, keyword. Keep labels short, specific, lowercase, and deduplicated. No em dashes.';
  const user = `ABOUT THEM:\n${input.bioRaw}\n\nWORKING ON:\n${input.workingOnRaw}\n\nTRACK CLOSELY:\n${input.trackRaw}\n\nMOSTLY IGNORE:\n${input.ignoreRaw}\n\nADDITIONAL CONTEXT AND FILES:\n${input.contextRaw ?? ''}`;
  try {
    const res = await callModel({ role: 'reasoning', system, user, jsonSchema: { name: 'profile', schema: DerivedSchema }, maxTokens: 650 });
    return DerivedSchema.parse(JSON.parse(res.content));
  } catch (e) {
    log.warn('derive_profile_fallback', { error: (e as Error).message });
    return fallbackDerive(input);
  }
}

function fallbackDerive(input: RawAnswers): DerivedProfile {
  const personaSummary = [input.bioRaw.trim(), input.workingOnRaw.trim() ? `Currently working on: ${input.workingOnRaw.trim()}.` : '']
    .filter(Boolean)
    .join(' ');
  const interests: DerivedInterest[] = [
    ...splitLabels(input.trackRaw).map((label) => ({ label, kind: 'topic', weight: 2 })),
    ...splitLabels(input.ignoreRaw).map((label) => ({ label, kind: 'topic', weight: -2 })),
  ];
  return { personaSummary, interests };
}

function splitLabels(s: string): string[] {
  return s
    .split(/[,;\n]| and /i)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length >= 2 && x.length <= 40);
}

export async function getProfile(accountId: AccountId): Promise<UserProfile | null> {
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.accountId, accountId)).limit(1);
  return rows[0] ?? null;
}

export async function getInterests(accountId: AccountId): Promise<Interest[]> {
  return db.select().from(interests).where(eq(interests.accountId, accountId));
}
