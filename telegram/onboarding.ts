import { eq } from 'drizzle-orm';
import { db } from '../lib/db';
import { accounts, userProfiles, productFeedback } from '../core/schema/tables';
import { deriveProfile } from '../core/memory/profile';
import { addContext } from '../core/memory/context';
import { getState, setState } from './store';

// The onboarding state machine (spec Section 12.4), extended with a context-dump step (paste
// text or send files) and an integrations-interest step. Driven by conversation_state.
// Tone: meeting an analyst, not filling a form. Free /start, no connect token.

export const FIRST_PROMPT =
  "I'm Winnow. I watch the noise so you don't have to, and brief you only on what actually matters to you. The more you tell me, the sharper I get. You can type or send voice notes throughout.\n\nFirst: what should I understand about you? Tell me who you are, what you do, and how you think.";

const STEP_ORDER = ['bio', 'workingOn', 'track', 'ignore', 'context', 'integrations', 'timezone', 'style'] as const;
type StepKey = (typeof STEP_ORDER)[number];

const PROMPTS: Record<StepKey, string> = {
  bio: FIRST_PROMPT,
  workingOn: 'What are you building or working on right now?',
  track: 'What topics, companies, or people should I track closely? List as many as you like.',
  ignore: 'And what should I mostly ignore?',
  context:
    "Anything else I should know? Paste any extra context, or send me files (notes, docs, a brief, a CV). Send as much as you like, then type 'done'. Or 'skip'.",
  integrations:
    "Which of your tools should I plug into? If you use Creed, connect it right now with /connect creed <your token> and I'll pull your profile in. Gmail, Notion, and Calendar are coming soon, list any and I'll note them. Or 'skip'.",
  timezone: 'What timezone are you in? For example: Europe/London',
  style: 'Last one. How should I write? concise, balanced, detailed, blunt, or technical?',
};

const CONTEXT_CAP = 50_000;

export interface OnboardingResult {
  reply: string;
  done: boolean;
  generateNow: boolean;
}

export async function startOnboarding(accountId: string): Promise<string> {
  await setState(accountId, { currentFlow: 'onboarding', step: 'bio', scratch: {} });
  return PROMPTS.bio;
}

export async function advanceOnboarding(accountId: string, text: string): Promise<OnboardingResult> {
  const state = await getState(accountId);
  const stepKey = (state.step ?? 'bio') as StepKey;
  const scratch = { ...state.scratch };
  const answer = text.trim();

  // Sticky context-dump step: accumulate text + files until "done"/"skip".
  if (stepKey === 'context') {
    if (/^(done|skip)$/i.test(answer)) {
      await setState(accountId, { currentFlow: 'onboarding', step: 'integrations', scratch });
      return { reply: PROMPTS.integrations, done: false, generateNow: false };
    }
    scratch.contextDump = `${(scratch.contextDump as string) ?? ''}\n\n${answer}`.trim();
    await setState(accountId, { currentFlow: 'onboarding', step: 'context', scratch });
    return { reply: "Added. Send more context or files, or type 'done'.", done: false, generateNow: false };
  }

  if (stepKey === 'timezone') {
    const timezone = parseTimezone(answer);
    if (!timezone) {
      return { reply: 'I did not catch a valid timezone. Try something like "Europe/London".', done: false, generateNow: false };
    }
    scratch.timezone = timezone;
  } else if (stepKey === 'style') {
    scratch.style = parseStyle(answer);
  } else if (stepKey === 'integrations') {
    scratch.integrations = /^skip$/i.test(answer) ? '' : answer;
  } else {
    // bio / workingOn / track / ignore
    scratch[stepKey] = /^skip$/i.test(answer) ? '' : answer;
  }

  const idx = STEP_ORDER.indexOf(stepKey);
  const next = STEP_ORDER[idx + 1];
  if (!next) {
    await finalize(accountId, scratch);
    return { reply: "Got it. I'll generate your first briefing now.", done: true, generateNow: true };
  }

  await setState(accountId, { currentFlow: 'onboarding', step: next, scratch });
  return { reply: PROMPTS[next], done: false, generateNow: false };
}

async function finalize(accountId: string, scratch: Record<string, unknown>): Promise<void> {
  const s = scratch as Record<string, string | number | undefined>;
  const dump = ((s.contextDump as string) ?? '').slice(0, CONTEXT_CAP);

  await db
    .insert(userProfiles)
    .values({
      accountId,
      writingStyle: (s.style as string) ?? 'balanced',
      timezone: (s.timezone as string) ?? 'UTC',
    })
    .onConflictDoUpdate({
      target: userProfiles.accountId,
      set: {
        writingStyle: (s.style as string) ?? 'balanced',
        timezone: (s.timezone as string) ?? 'UTC',
        updatedAt: new Date(),
      },
    });

  await deriveProfile(accountId, {
    bioRaw: (s.bio as string) ?? '',
    workingOnRaw: (s.workingOn as string) ?? '',
    trackRaw: (s.track as string) ?? '',
    ignoreRaw: (s.ignore as string) ?? '',
    contextRaw: dump,
  });

  // Preserve every substantive onboarding answer verbatim. The derived profile is useful
  // for ranking, but it must never be the only surviving representation of what they said.
  const onboardingContext = [
    `ABOUT THEM:\n${(s.bio as string) ?? ''}`,
    `CURRENT WORK:\n${(s.workingOn as string) ?? ''}`,
    `TRACK CLOSELY:\n${(s.track as string) ?? ''}`,
    `MOSTLY IGNORE:\n${(s.ignore as string) ?? ''}`,
    dump ? `ADDITIONAL CONTEXT AND FILES:\n${dump}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  if (onboardingContext.trim()) {
    await addContext(accountId, {
      source: 'onboarding',
      label: 'complete onboarding answers',
      content: onboardingContext.slice(0, CONTEXT_CAP),
    });
  }

  // Capture integration interest (OAuth providers are a later milestone; Creed connects now).
  if (s.integrations) {
    await db.insert(productFeedback).values({ accountId, message: `Integration interest: ${s.integrations}` });
  }

  await db.update(accounts).set({ onboardedAt: new Date() }).where(eq(accounts.id, accountId));
  await setState(accountId, { currentFlow: 'idle', step: null, scratch: {} });
}

function parseTimezone(text: string): string | null {
  const timezone = text.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return null;
  }
  return timezone;
}

function parseStyle(text: string): string {
  const m = /(concise|balanced|detailed|blunt|technical)/i.exec(text);
  return m ? m[1]!.toLowerCase() : 'balanced';
}

/** True while the user is in onboarding (so the router can route file uploads into context). */
export async function isOnboarding(accountId: string): Promise<boolean> {
  const state = await getState(accountId);
  return state.currentFlow === 'onboarding';
}

/**
 * Append a sent file's text to the in-flight onboarding context, at ANY step (not just the
 * dedicated context step). Keeps the user on their current step and restates the question.
 */
export async function ingestOnboardingFile(accountId: string, label: string, text: string): Promise<string> {
  const state = await getState(accountId);
  const scratch = { ...state.scratch };
  scratch.contextDump = `${(scratch.contextDump as string) ?? ''}\n\n[file: ${label}]\n${text}`.trim();
  const step = (state.step ?? 'bio') as StepKey;
  await setState(accountId, { currentFlow: 'onboarding', step, scratch });
  if (step === 'context') return `Added ${label}. Send more context or files, or type "done".`;
  return `Got it, I have saved ${label} as context. Now, back to it: ${PROMPTS[step] ?? ''}`;
}
