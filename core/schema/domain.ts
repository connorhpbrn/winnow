import type { BriefItem } from './brief';

// The leak firewall (spec Appendix A #2). Every /core function speaks only these
// domain types. No Telegram `Update`/`Message`, no `Stripe.Event`, no Trigger task
// types ever appear in a /core signature. Adapters translate to/from these.

export type AccountId = string;
export type StoryId = string;
export type BriefId = string;
export type InterestId = string;

/** Inbound message into core, transport-neutral. The Telegram webhook AND the CLI both build this. */
export interface InboundMessage {
  accountId: AccountId;
  text: string;
  /** Resolved by the adapter from any reply context into a stable brief-item id. */
  replyToItemId?: string;
  editionDate?: string;
}

// Semantic, renderer-agnostic reply blocks. NEVER HTML (the adapter renders them).
export type ReplyBlock =
  | { kind: 'text'; text: string }
  | { kind: 'item'; item: BriefItem }
  | { kind: 'list'; title?: string; items: string[] }
  | { kind: 'link'; label: string; url: string }
  | { kind: 'confirm'; prompt: string; confirmId: string };

// Side effects core REQUESTS but does not perform. Keeps Stripe/Telegram/Trigger out of core:
// core names the effect, the adapter performs it.
export type ReplyEffect =
  | { kind: 'open_billing_portal' }
  | { kind: 'start_cancel'; periodEndIso: string }
  | { kind: 'trigger_brief' }
  | { kind: 'trigger_deep_dive'; itemId: string };

/** The transport-neutral output of every conversational core fn. Renders to Telegram HTML OR CLI text. */
export interface Reply {
  blocks: ReplyBlock[];
  effects?: ReplyEffect[];
}

export type Intent =
  | 'follow_up'
  | 'more'
  | 'deep'
  | 'sources'
  | 'track'
  | 'untrack'
  | 'ignore'
  | 'more_like'
  | 'less_like'
  | 'edit_schedule'
  | 'edit_topics'
  | 'feedback'
  | 'remember'
  | 'smalltalk'
  | 'unknown';

// Small builders so core code constructs replies without touching any transport format.
export const block = {
  text: (text: string): ReplyBlock => ({ kind: 'text', text }),
  item: (item: BriefItem): ReplyBlock => ({ kind: 'item', item }),
  list: (items: string[], title?: string): ReplyBlock => ({ kind: 'list', title, items }),
  link: (label: string, url: string): ReplyBlock => ({ kind: 'link', label, url }),
  confirm: (prompt: string, confirmId: string): ReplyBlock => ({ kind: 'confirm', prompt, confirmId }),
};

export function textReply(text: string, effects?: ReplyEffect[]): Reply {
  return { blocks: [block.text(text)], effects };
}
