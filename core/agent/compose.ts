import { callModel, type ModelUsage } from '../models/client';
import { BriefSchema, parseBrief, type Brief } from '../schema/brief';
import { buildComposePrompt, type ComposeInput } from './prompts';

export type { ComposeInput } from './prompts';

// Stage 2 (spec Section 10.2): the one expensive reasoning call. Returns a discriminated
// result rather than throwing, so generateBrief can drive the repair loop explicitly.
export type ComposeResult =
  | { ok: true; brief: Brief; usage: ModelUsage }
  | { ok: false; rawOutput: string; zodError: string; usage: ModelUsage };

export async function composeBrief(input: ComposeInput): Promise<ComposeResult> {
  const { system, user } = buildComposePrompt(input);
  const res = await callModel({
    role: 'reasoning',
    system,
    user,
    jsonSchema: { name: 'brief', schema: BriefSchema },
    temperature: 0.4,
    maxTokens: 1800,
  });
  const parsed = parseBrief(res.content);
  if (parsed.ok) return { ok: true, brief: enforceCandidateImages(parsed.brief, input), usage: res.usage };
  return { ok: false, rawOutput: res.content, zodError: parsed.zodError, usage: res.usage };
}

function enforceCandidateImages(brief: Brief, input: ComposeInput): Brief {
  const allowed = new Map(input.candidates.filter((c) => c.card.image).map((c) => [c.card.id, c.card.image!]));
  return {
    ...brief,
    items: brief.items.map((item) => {
      const candidate = allowed.get(item.id);
      if (!item.image || !candidate || item.image.url !== candidate.url) {
        const { image: _image, ...withoutImage } = item;
        return withoutImage;
      }
      return {
        ...item,
        image: {
          ...item.image,
          credit: item.image.credit ?? candidate.credit,
        },
      };
    }),
  };
}
