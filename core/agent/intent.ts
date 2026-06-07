import { z } from 'zod';
import { callModel } from '../models/client';
import { hasOpenRouterKey } from '../../lib/env';
import type { Intent } from '../schema/domain';

export interface ClassifiedIntent {
  intent: Intent;
  args?: { n?: string; label?: string; text?: string };
}

// Deterministic fast-paths for reply commands and common phrasings; the bulk model handles
// the long tail of natural language (spec Section 12.3). Intent classification uses the
// BULK model (cheap), not reasoning.
export async function classifyIntent(input: { text: string; hasReplyContext: boolean }): Promise<ClassifiedIntent> {
  const t = input.text.trim();
  const lower = t.toLowerCase();

  const num = /^(more|deep|sources?)\s+(\d+)\b/.exec(lower);
  if (num) {
    const kind = num[1]!.startsWith('source') ? 'sources' : (num[1] as 'more' | 'deep');
    return { intent: kind, args: { n: num[2] } };
  }

  if (/^track this\b/.test(lower)) return { intent: 'track', args: {} };
  if (/^more like this\b/.test(lower)) return { intent: 'more_like', args: {} };
  if (/^(ignore this|less like this)\b/.test(lower)) {
    return { intent: lower.startsWith('ignore') ? 'ignore' : 'less_like', args: {} };
  }

  const phrase = (re: RegExp, intent: Intent): ClassifiedIntent | null => {
    const m = re.exec(t);
    return m ? { intent, args: { label: m[2]!.trim().toLowerCase() } } : null;
  };

  return (
    phrase(/^(untrack|stop tracking)\s+(.+)/i, 'untrack') ??
    phrase(/^(track|follow)\s+(.+)/i, 'track') ??
    phrase(/^(ignore|mute|stop)\s+(.+)/i, 'ignore') ??
    phrase(/^(more like|more of|more)\s+(.+)/i, 'more_like') ??
    phrase(/^(less like|less of|less)\s+(.+)/i, 'less_like') ??
    (/^(remember|context|about me)[:\s]+/i.test(t)
      ? { intent: 'remember', args: { text: t.replace(/^(remember|context|about me)[:\s]+/i, '').trim() } }
      : null) ??
    (/^feedback[:\s]/i.test(t) ? { intent: 'feedback', args: { text: t.replace(/^feedback[:\s]+/i, '') } } : null) ??
    (await modelClassify(t))
  );
}

const IntentSchema = z.object({
  intent: z.enum([
    'track',
    'untrack',
    'ignore',
    'more_like',
    'less_like',
    'edit_schedule',
    'edit_topics',
    'feedback',
    'remember',
    'follow_up',
    'smalltalk',
    'unknown',
  ]),
  label: z.string().optional(),
});

async function modelClassify(text: string): Promise<ClassifiedIntent> {
  if (!hasOpenRouterKey()) return { intent: 'unknown' };
  const system =
    'Classify a message to a personal briefing agent into one intent and extract a topic label if present. Intents: track, untrack, ignore, more_like, less_like, edit_schedule, edit_topics, remember (the user is supplying durable context about themselves), feedback (product feedback for the team), follow_up (a question about the brief), smalltalk, unknown. Return JSON {"intent": string, "label": string optional}.';
  try {
    const res = await callModel({ role: 'bulk', system, user: text, json: true, maxTokens: 120 });
    const parsed = IntentSchema.parse(JSON.parse(res.content));
    return { intent: parsed.intent, args: parsed.label ? { label: parsed.label.toLowerCase() } : {} };
  } catch {
    return { intent: 'unknown' };
  }
}
