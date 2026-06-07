import OpenAI from 'openai';
import { z } from 'zod';
import { env, requireOpenRouterKey } from '../../lib/env';
import { log } from '../../lib/log';
import { MODELS, MODEL_PRICES_PER_1M, type ModelRole } from './models';

// OpenAI-compatible client pointed at OpenRouter. All LLM calls go through here.
let _client: OpenAI | undefined;
function client(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: requireOpenRouterKey(),
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': env.OPENROUTER_HTTP_REFERER,
        'X-Title': env.OPENROUTER_APP_TITLE,
      },
      maxRetries: 2,
      timeout: 90_000,
    });
  }
  return _client;
}

export interface ModelUsage {
  role: ModelRole;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd: number;
}

export interface CallModelArgs {
  role: ModelRole;
  system: string;
  user: string;
  /** Request structured output guided by this JSON schema (re-validate with Zod regardless). */
  jsonSchema?: { name: string; schema: z.ZodType };
  /** Force a JSON object response (no schema). Ignored if jsonSchema is set. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** OpenRouter web plugin. For xAI models this enables native Web Search and X Search. */
  webSearch?: {
    maxResults?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
    searchContextSize?: 'low' | 'medium' | 'high';
  };
}

export interface CallModelResult {
  content: string;
  usage: ModelUsage;
  citations: Array<{ url: string; title?: string; content?: string }>;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // zod 4 native JSON Schema. Inline reused subschemas so there are no $ref/$defs for the
  // provider to choke on; re-validation with Zod is the real contract regardless.
  const js = z.toJSONSchema(schema, { target: 'draft-2020-12', reused: 'inline' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/**
 * Single entry point for model calls. Returns the raw text content plus a usage record
 * (also logged). Callers that expect JSON validate the content themselves (e.g. parseBrief),
 * which keeps the repair loop explicit and lets structured-output be a hint, not a guarantee.
 */
export async function callModel(args: CallModelArgs): Promise<CallModelResult> {
  const model = MODELS[args.role];

  let responseFormat: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'];
  if (args.jsonSchema) {
    responseFormat = {
      type: 'json_schema',
      json_schema: { name: args.jsonSchema.name, strict: false, schema: toJsonSchema(args.jsonSchema.schema) },
    };
  } else if (args.json) {
    responseFormat = { type: 'json_object' };
  }

  const startedAt = Date.now();
  let ok = false;
  let promptTokens = 0;
  let completionTokens = 0;
  try {
    const request = {
      model,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      temperature: args.temperature ?? 0.3,
      max_tokens: args.maxTokens,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(args.webSearch
        ? {
            plugins: [
              {
                id: 'web',
                engine: 'native',
                max_results: args.webSearch.maxResults ?? 10,
                ...(args.webSearch.includeDomains ? { include_domains: args.webSearch.includeDomains } : {}),
                ...(args.webSearch.excludeDomains ? { exclude_domains: args.webSearch.excludeDomains } : {}),
              },
            ],
            web_search_options: {
              search_context_size: args.webSearch.searchContextSize ?? 'low',
            },
          }
        : {}),
    };
    const resp = await client().chat.completions.create(request as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    promptTokens = resp.usage?.prompt_tokens ?? 0;
    completionTokens = resp.usage?.completion_tokens ?? 0;
    const content = resp.choices[0]?.message?.content ?? '';
    const annotations = (resp.choices[0]?.message as unknown as { annotations?: Array<Record<string, unknown>> })?.annotations ?? [];
    const citations = annotations
      .map((annotation) => annotation.url_citation as { url?: string; title?: string; content?: string } | undefined)
      .filter((citation): citation is { url: string; title?: string; content?: string } => Boolean(citation?.url));
    ok = true;
    const usage = buildUsage(args.role, model, promptTokens, completionTokens, Date.now() - startedAt);
    log.model({ ...usage, ok });
    return { content, usage, citations };
  } catch (err) {
    const usage = buildUsage(args.role, model, promptTokens, completionTokens, Date.now() - startedAt);
    log.model({ ...usage, ok });
    log.error('model_call_failed', { role: args.role, model, error: (err as Error).message });
    throw err;
  }
}

function buildUsage(
  role: ModelRole,
  model: string,
  promptTokens: number,
  completionTokens: number,
  latencyMs: number,
): ModelUsage {
  const price = MODEL_PRICES_PER_1M[role];
  const costUsd = (promptTokens / 1e6) * price.input + (completionTokens / 1e6) * price.output;
  return { role, model, promptTokens, completionTokens, latencyMs, costUsd };
}
