import { eq } from 'drizzle-orm';
import { db } from '../lib/db';
import {
  accounts,
  conversationState,
  userProfiles,
  interests,
  memoryEvents,
  briefs,
  seenStories,
  usageDaily,
  generationLocks,
  productFeedback,
} from '../core/schema/tables';

// Telegram-side persistence helpers. conversation_state is rehydrated on every inbound
// message (spec Section 2: Telegram is stateless; all state lives in the DB).

export async function getOrCreateAccountByTelegram(
  userId: number,
  chatId: number,
): Promise<{ id: string; onboardedAt: Date | null; isNew: boolean }> {
  const existing = await db.select().from(accounts).where(eq(accounts.telegramUserId, userId)).limit(1);
  if (existing[0]) {
    if (existing[0].telegramChatId !== chatId) {
      await db.update(accounts).set({ telegramChatId: chatId }).where(eq(accounts.id, existing[0].id));
    }
    return { id: existing[0].id, onboardedAt: existing[0].onboardedAt, isNew: false };
  }
  // No Stripe in the dev bot: a new Telegram user gets an active account directly.
  const inserted = await db
    .insert(accounts)
    .values({ subscriptionStatus: 'active', telegramUserId: userId, telegramChatId: chatId })
    .returning({ id: accounts.id });
  return { id: inserted[0]!.id, onboardedAt: null, isNew: true };
}

export interface ConvState {
  currentFlow: string;
  step: string | null;
  scratch: Record<string, unknown>;
}

export async function getState(accountId: string): Promise<ConvState> {
  const rows = await db.select().from(conversationState).where(eq(conversationState.accountId, accountId)).limit(1);
  const r = rows[0];
  if (!r) return { currentFlow: 'idle', step: null, scratch: {} };
  return { currentFlow: r.currentFlow, step: r.step, scratch: (r.scratch as Record<string, unknown>) ?? {} };
}

export async function setState(
  accountId: string,
  s: { currentFlow: string; step?: string | null; scratch?: Record<string, unknown> },
): Promise<void> {
  const values = { currentFlow: s.currentFlow, step: s.step ?? null, scratch: s.scratch ?? {}, updatedAt: new Date() };
  await db
    .insert(conversationState)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: conversationState.accountId, set: values });
}

/** /reset: wipe a Telegram user's Winnow data so they can start over. Keeps the account row
 *  (and Telegram binding) but clears profile, interests, memory, briefs, and onboarding state. */
export async function resetAccountData(accountId: string): Promise<void> {
  await db.delete(seenStories).where(eq(seenStories.accountId, accountId));
  await db.delete(briefs).where(eq(briefs.accountId, accountId));
  await db.delete(memoryEvents).where(eq(memoryEvents.accountId, accountId));
  await db.delete(interests).where(eq(interests.accountId, accountId));
  await db.delete(usageDaily).where(eq(usageDaily.accountId, accountId));
  await db.delete(generationLocks).where(eq(generationLocks.accountId, accountId));
  await db.delete(productFeedback).where(eq(productFeedback.accountId, accountId));
  await db.delete(conversationState).where(eq(conversationState.accountId, accountId));
  await db.delete(userProfiles).where(eq(userProfiles.accountId, accountId));
  await db.update(accounts).set({ onboardedAt: null }).where(eq(accounts.id, accountId));
}
