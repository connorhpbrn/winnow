import { z } from 'zod';
import { callModel } from '../models/client';
import { hasOpenRouterKey } from '../../lib/env';

const CoveragePlanSchema = z.object({
  beats: z
    .array(
      z.object({
        label: z.string(),
        priority: z.number().min(1).max(3),
        search_terms: z.array(z.string()).min(1).max(12),
        rationale: z.string(),
      }),
    )
    .min(3)
    .max(8),
  exclusions: z.array(z.string()).max(20).default([]),
});

export type CoveragePlan = z.infer<typeof CoveragePlanSchema>;

export async function buildCoveragePlan(input: {
  persona: string;
  context: string;
  interests: Array<{ label: string; weight: number }>;
}): Promise<CoveragePlan> {
  const positive = input.interests.filter((interest) => interest.weight > 0).sort((a, b) => b.weight - a.weight);
  const negative = input.interests.filter((interest) => interest.weight < 0).sort((a, b) => a.weight - b.weight);

  if (!hasOpenRouterKey()) {
    return {
      beats: positive.slice(0, 6).map((interest) => ({
        label: interest.label,
        priority: Math.max(1, Math.min(3, Math.round(interest.weight))),
        search_terms: [interest.label],
        rationale: 'Explicitly tracked by the reader.',
      })),
      exclusions: negative.map((interest) => interest.label),
    };
  }

  const system = `You are the coverage editor for a deeply personalised newspaper. Convert the reader's full context into a balanced set of explicit news beats.

Rules:
- Produce 4 to 8 distinct beats when the context supports them.
- Do not collapse the person into their job. Include meaningful personal, collector, creative, local, sport, cultural, or hobby interests when the context gives them real weight.
- Give active work and urgent decisions priority, but preserve durable interests that a generic tech newspaper would miss.
- A named section or repeated subject in a canonical profile is meaningful even when it is not their current job.
- Distinguish active projects from parked ideas and incidental mentions.
- search_terms must include names, aliases, products, companies, people, adjacent markets, specialist publications, and event types that would reveal genuinely new developments.
- Explicit track signals outrank inferred interests. Explicit ignores become exclusions.
- Do not invent interests.
- Return only JSON.`;
  const user = `PERSONA:
${input.persona}

FULL CONTEXT:
${input.context}

EXPLICIT INTEREST WEIGHTS:
${positive.map((interest) => `+${interest.weight} ${interest.label}`).join('\n') || '(none)'}
${negative.map((interest) => `${interest.weight} ${interest.label}`).join('\n') || '(none)'}`;

  try {
    const result = await callModel({
      role: 'reasoning',
      system,
      user,
      jsonSchema: { name: 'coverage_plan', schema: CoveragePlanSchema },
      temperature: 0.1,
      maxTokens: 1400,
    });
    return CoveragePlanSchema.parse(JSON.parse(result.content));
  } catch {
    return {
      beats: positive.slice(0, 8).map((interest) => ({
        label: interest.label,
        priority: Math.max(1, Math.min(3, Math.round(interest.weight))),
        search_terms: [interest.label],
        rationale: 'Explicitly tracked by the reader.',
      })),
      exclusions: negative.map((interest) => interest.label),
    };
  }
}
