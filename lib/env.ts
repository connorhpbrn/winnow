import 'dotenv/config';
import { z } from 'zod';

// Validated environment. Milestone 1 needs only OPENROUTER_API_KEY (for model calls)
// and optionally DATABASE_URL (unset => bundled PGlite dev database).
const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().optional(),
  DATABASE_DIRECT_URL: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_HTTP_REFERER: z.string().default('https://winnow.to'),
  OPENROUTER_APP_TITLE: z.string().default('Winnow'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_DEV_BOT_TOKEN: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().default(8765),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env: Env = parsed.data;

/** True when no DATABASE_URL is set: use the local in-process PGlite database. */
export const usingPglite = !env.DATABASE_URL;

/** Model calls require an OpenRouter key. Throw a clear, actionable error if missing. */
export function requireOpenRouterKey(): string {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Add it to .env (get a key at https://openrouter.ai/keys). ' +
        'It is required for model calls: brief composition and story-card summaries.',
    );
  }
  return env.OPENROUTER_API_KEY;
}

export function hasOpenRouterKey(): boolean {
  return Boolean(env.OPENROUTER_API_KEY);
}

export function requireTelegramToken(): string {
  const token = env.TELEGRAM_BOT_TOKEN ?? env.TELEGRAM_DEV_BOT_TOKEN;
  if (!token) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather in Telegram, then add the token to the environment.',
    );
  }
  return token;
}
