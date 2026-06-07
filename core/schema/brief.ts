import { z } from 'zod';

// THE frozen interface (spec Section 8). The composer produces it; the Telegram
// formatter and the edition renderer consume it. Three consumers, one definition.
// The model emits ONLY this JSON, never HTML (cardinal rule #4).

export const SourceRef = z.object({
  title: z.string(),
  url: z.url(),
  publisher: z.string().optional(),
});

export const SignalQuality = z.enum(['high', 'medium', 'low']);

export const BriefImageSchema = z.object({
  url: z.url(),
  alt: z.string().min(1),
  credit: z.string().optional(),
});

export const BriefItemSchema = z.object({
  id: z.string(), // stable id, maps to a story id
  is_update: z.boolean().optional(), // deterministic from the story revision; optional for older persisted briefs
  headline: z.string(), // short factual news headline, never personalised
  what_changed: z.string(), // 1-2 sentences, paraphrased
  why_it_matters: z.string(), // concrete, references the user's context (kept for the model's reasoning)
  editorial_summary: z.string().optional(), // factual, self-contained news copy; optional for older persisted briefs
  watch_next: z.string().optional(), // personal relevance, consequence, or a concrete next event; rendered as an unlabeled accent note
  signal_quality: SignalQuality,
  signal_note: z.string(), // why it is high/medium/low signal
  action: z.string(), // often "No action, just awareness"
  matters_to_you: z.boolean(), // false = lower relevance
  genres: z.array(z.object({ label: z.string(), color: z.string() })).optional(), // AI-picked topic tags + hex colours (1-3, fewest that fit)
  image: BriefImageSchema.optional(), // selected only from the story card's supplied image candidate
  sources: z.array(SourceRef).min(1),
});

export const BriefSchema = z.object({
  edition_date: z.string(), // ISO date
  greeting: z.string(), // short, e.g. "Morning brief, 7 June"
  items: z.array(BriefItemSchema), // may be empty on a quiet day
  quiet_note: z.string().optional(), // present when items is empty or thin
  closing: z.string().optional(), // a short closing verdict, in Winnow's voice
});

export type SourceRefT = z.infer<typeof SourceRef>;
export type BriefItem = z.infer<typeof BriefItemSchema>;
export type Brief = z.infer<typeof BriefSchema>;

export type ParseBriefResult = { ok: true; brief: Brief } | { ok: false; zodError: string };

/** Validate a model's raw output into a Brief, or return a structured error for the repair loop. */
export function parseBrief(raw: string): ParseBriefResult {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(raw));
  } catch (e) {
    return { ok: false, zodError: `JSON parse error: ${(e as Error).message}` };
  }
  const result = BriefSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, zodError: JSON.stringify(z.flattenError(result.error)) };
  }
  return { ok: true, brief: result.data };
}

// Defensive: strip ```json ... ``` fences if a model adds them despite instructions.
function stripFences(s: string): string {
  const t = s.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return fence && fence[1] !== undefined ? fence[1] : t;
}
