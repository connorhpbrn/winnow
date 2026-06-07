import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  jsonb,
  date,
  bigint,
  timestamp,
  real,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Drizzle translation of spec Section 6. All timestamps are timestamptz; all ids are
// uuid default gen_random_uuid() unless noted. The one addition beyond Section 6 is the
// nullable `debug` jsonb on `briefs`, which persists the generation log.

const tstz = (name: string) => timestamp(name, { withTimezone: true });

// The paying account. One per Stripe customer.
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  // enum: incomplete | active | cancel_scheduled | past_due | canceled
  subscriptionStatus: text('subscription_status').notNull().default('incomplete'),
  currentPeriodEnd: tstz('current_period_end'),
  plan: text('plan').notNull().default('standard'),
  telegramUserId: bigint('telegram_user_id', { mode: 'number' }).unique(), // null until /start binds it
  telegramChatId: bigint('telegram_chat_id', { mode: 'number' }),
  briefsPaused: boolean('briefs_paused').notNull().default(false), // /pause flag (M4)
  onboardedAt: tstz('onboarded_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// Single-use token that bridges web payment to Telegram identity.
export const connectTokens = pgTable('connect_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  tokenHash: text('token_hash').notNull(), // store a hash, not the raw token
  expiresAt: tstz('expires_at').notNull(), // TTL 45 minutes
  consumedAt: tstz('consumed_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// Conversational state machine. Rehydrated on every inbound message.
export const conversationState = pgTable('conversation_state', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id),
  // idle | onboarding | awaiting_feedback | editing_topics | editing_schedule
  currentFlow: text('current_flow').notNull().default('idle'),
  step: text('step'),
  scratch: jsonb('scratch').default({}),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

// Derived + raw profile. Raw is source of truth; derived is what ranking queries.
export const userProfiles = pgTable('user_profiles', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id),
  bioRaw: text('bio_raw'),
  workingOnRaw: text('working_on_raw'),
  personaSummary: text('persona_summary'),
  // concise | balanced | detailed | blunt | technical
  writingStyle: text('writing_style').default('balanced'),
  briefCadence: text('brief_cadence').default('daily'), // daily | weekly
  briefTime: text('brief_time').default('07:00'), // HH:MM in the user's local time
  timezone: text('timezone').default('UTC'), // IANA, e.g. Europe/London. MUST be captured.
  weeklyDay: integer('weekly_day'), // 0-6 if cadence = weekly
  contextDigest: text('context_digest'), // compacted summary of all context_items, injected into the composer
  contextDigestAt: tstz('context_digest_at'),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

// Tracked topics/entities and ignore list, unified as signed weights.
export const interests = pgTable('interests', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  label: text('label').notNull(),
  kind: text('kind').notNull(), // topic | entity | company | person | keyword
  weight: numeric('weight', { mode: 'number' }).notNull().default(1), // positive = track, negative = ignore
  source: text('source').notNull().default('onboarding'), // onboarding | feedback | inferred
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// Configured source feeds (global, not per user).
export const sources = pgTable('sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // rss | hn | github_releases | blog | changelog
  url: text('url').notNull(),
  credibilityTier: integer('credibility_tier').notNull().default(2), // 1 official, 2 reputable, 3 aggregator
  active: boolean('active').notNull().default(true),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// The shared global story pool (cached story cards).
export const stories = pgTable('stories', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').references(() => sources.id),
  canonicalUrl: text('canonical_url').unique(), // canonicalised for dedupe
  title: text('title').notNull(),
  eventKey: text('event_key'), // stable semantic event identity across sources and later updates
  revision: integer('revision').notNull().default(1), // increments when an event materially changes
  summary: text('summary'), // model-written, paraphrased, <= 60 words
  topics: text('topics').array().default(sql`'{}'::text[]`), // extracted topics/entities for keyword pre-filter
  credibilityScore: numeric('credibility_score', { mode: 'number' }),
  publishedAt: tstz('published_at'),
  ingestedAt: tstz('ingested_at').notNull().defaultNow(),
  // NULLABLE, reserved for post-v1 semantic ranking. Stored as real[] for dev-DB portability
  // (PGlite has no pgvector); the post-v1 pgvector feature converts this to a vector column + index.
  embedding: real('embedding').array(),
  raw: jsonb('raw'), // original feed item for re-derivation
  evidence: jsonb('evidence'), // extracted source text, dates, and claim-level support
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

// A generated brief. payload holds the validated brief JSON (Section 8).
export const briefs = pgTable('briefs', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  publicId: text('public_id').notNull().unique(), // unguessable slug for the edition URL
  editionDate: date('edition_date').notNull(),
  payload: jsonb('payload').notNull(), // conforms to BriefSchema
  debug: jsonb('debug'), // generation log: candidate set, what was cut, final item ids (Section 17)
  expiresAt: tstz('expires_at').notNull(), // 7 days from creation
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// Which stories a user has already seen, to prevent repeats.
export const seenStories = pgTable(
  'seen_stories',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id),
    revision: integer('revision').notNull().default(1),
    briefId: uuid('brief_id').references(() => briefs.id),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.storyId, t.revision] })],
);

// Append-only personalisation feedback log. Never mutated. Folded into interests periodically.
export const memoryEvents = pgTable('memory_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  type: text('type').notNull(), // ignore | more_like | less_like | more_detail | track | untrack
  payload: jsonb('payload').default({}),
  relatedStoryId: uuid('related_story_id').references(() => stories.id),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// Daily usage counters for rate limiting. Upserted atomically.
export const usageDaily = pgTable(
  'usage_daily',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    day: date('day').notNull(),
    briefs: integer('briefs').notNull().default(0),
    followUps: integer('follow_ups').notNull().default(0),
    deepDives: integer('deep_dives').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.day] })],
);

// A simple lock to enforce "one active generation per user at a time".
export const generationLocks = pgTable('generation_locks', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id),
  lockedAt: tstz('locked_at').notNull(),
  job: text('job'), // what acquired the lock
});

// Product feedback destined for Median.
export const productFeedback = pgTable('product_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  message: text('message').notNull(),
  sentToMedian: boolean('sent_to_median').notNull().default(false),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// Accumulating per-user context (onboarding dump, files, forwards, /remember, MCP fetches).
// Compacted into user_profiles.context_digest and injected into the composer so papers
// improve as more context is captured.
export const contextItems = pgTable('context_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  source: text('source').notNull(), // onboarding | file | remember | forward | mcp:<name>
  label: text('label'),
  content: text('content').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// Per-user external connections (v1: bearer-token MCP servers, e.g. Creed).
export const connections = pgTable('connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  kind: text('kind').notNull().default('mcp'),
  name: text('name').notNull(), // e.g. 'creed'
  url: text('url').notNull(),
  token: text('token'), // static bearer token (token-based servers)
  auth: jsonb('auth'), // OAuth state for OAuth servers: { clientInformation, tokens, codeVerifier }
  enabled: boolean('enabled').notNull().default(true),
  lastSyncedAt: tstz('last_synced_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// Row types inferred for use across /core (domain types, never transport types).
export type Account = typeof accounts.$inferSelect;
export type ContextItem = typeof contextItems.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type UserProfile = typeof userProfiles.$inferSelect;
export type Interest = typeof interests.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type StoryRow = typeof stories.$inferSelect;
export type BriefRow = typeof briefs.$inferSelect;
export type MemoryEvent = typeof memoryEvents.$inferSelect;
