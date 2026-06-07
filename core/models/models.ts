// The ONLY place model IDs live (spec Appendix A #4). Everything routes by role, so
// swapping a model is a one-line change here. Verify IDs + pricing at openrouter.ai/models
// at build time. Confirmed June 2026.
export const MODELS = {
  // Quality lever + cost centre. Runs ~once per user per day plus follow-ups.
  reasoning: 'anthropic/claude-sonnet-4.6',
  // Runs on every ingested story and on intent classification, so it must stay cheap.
  bulk: 'deepseek/deepseek-v3.2',
  // Global and user-context news discovery with native web + X search via OpenRouter.
  research: 'x-ai/grok-4.3',
} as const;

export type ModelRole = keyof typeof MODELS;

// USD per 1,000,000 tokens, for cost logging only (kept beside the IDs they describe).
export const MODEL_PRICES_PER_1M: Record<ModelRole, { input: number; output: number }> = {
  reasoning: { input: 3, output: 15 },
  bulk: { input: 0.23, output: 0.34 },
  research: { input: 1.25, output: 2.5 },
};
