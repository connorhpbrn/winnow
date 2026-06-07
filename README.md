# Winnow

A personal intelligence agent in Telegram: it researches the live web and X, monitors trusted feeds, filters noise, and briefs each user only on what matters to their work, interests, and goals.

> Wake up knowing what changed that actually matters to you.

Transport-agnostic `/core` (the agent), a `/telegram` dev bot, and `/lib` (db, edition renderer). Deploys on **Railway**. Built in milestones; see the build plan.

## Layout

```
/core      transport-agnostic agent + domain logic (NO telegram/stripe/trigger/next imports)
  /agent     prompts, composer, follow-up, deep-dive, generateBrief orchestration
  /pool      source ingestion, dedupe, story-card summarisation, credibility
             Grok 4.3 web + X discovery, event clustering, source-quality gates
  /ranking   deterministic pre-filter (selectCandidates)
  /memory    profile derivation, feedback folding
  /models    role -> model map (the only place model IDs live) + OpenRouter client
  /schema    Drizzle tables + Zod contracts (BriefSchema) + domain types
  /limits    rate limits + generation lock
  /mcp       bearer + OAuth MCP client (Creed) + per-user connections
  /memory    profile derivation, feedback folding, context store + digest
/telegram  Telegram dev bot: long-poll runner, router, onboarding FSM, formatter, OAuth callback
/lib       env, db client, logger, embedded-font edition renderer
/scripts   migrate, ingest (pool refresh), preview-edition, connect-creed
/test      unit tests for deterministic pieces
/app       landing + web edition route (later milestone)
```

## Setup (Milestone 1)

1. Install deps: `npm install`
2. Copy env: `cp .env.example .env`
   - **Database**: leave `DATABASE_URL` unset to use the bundled PGlite dev database (in-process Postgres 16, no Docker). Set it to a Postgres URL to use hosted Supabase instead.
   - **OpenRouter**: set `OPENROUTER_API_KEY` (required for brief composition and story summaries). Get one at https://openrouter.ai/keys
3. Generate + apply the schema: `npm run db:generate && npm run db:migrate`

## Running

```
npm run bot:dev    start the Telegram dev bot (long-poll; OAuth callback on :8765)
```

Every `/paper` request reads the user's latest context, builds personalised coverage beats,
searches the live web and X, verifies sources, and writes the edition on the spot. X is used
for discovery, never as sufficient verification by itself.

In Telegram: `/start` to onboard, `/paper` for a paper now, `/connect creed` to link Creed, or send text, voice notes, files, and forwards naturally.

## Production deployment

Winnow runs as one Railway service against one Supabase Postgres database:

- `winnow-bot`: long-running Telegram polling process, `npm start`

Required production variables:

```text
DATABASE_URL
DATABASE_DIRECT_URL
OPENROUTER_API_KEY
OPENROUTER_HTTP_REFERER
OPENROUTER_APP_TITLE
TELEGRAM_BOT_TOKEN
PUBLIC_BASE_URL
```

Use Supabase's transaction pooler URL for `DATABASE_URL` and direct connection URL for
`DATABASE_DIRECT_URL`. Apply migrations once with `npm run db:migrate`. The bot service
must have a Railway domain because OAuth providers redirect to `${PUBLIC_BASE_URL}/callback`.
Keep the bot at one replica because Telegram long polling should have one consumer.

## Model routing

All LLM calls route through OpenRouter (OpenAI-compatible). Roles are defined once in `core/models/models.ts`:
- `reasoning` (`anthropic/claude-sonnet-4.6`): brief composition, follow-ups, deep dives, onboarding extraction.
- `bulk` (`deepseek/deepseek-v3.2`): story-card summaries, topic extraction, intent classification.
- `research` (`x-ai/grok-4.3`): live Web Search + X Search and multi-source event discovery.
