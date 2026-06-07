import type { Brief, BriefItem } from '../core/schema/brief';
import type { Reply } from '../core/schema/domain';
import type { InlineKeyboard } from './client';

// Brief/Reply -> Telegram HTML. The chat version is deliberately lean (headline + what
// changed + source). The "why it matters", signal note, and action live in the newspaper
// edition (sent as an attached HTML file), not in the chat message. No em dashes.

export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function greetingHtml(brief: Brief): string {
  const count = brief.items.length;
  const sub = count === 0 ? '' : `\n<i>${count} ${count === 1 ? 'thing' : 'things'} worth your attention.</i>`;
  return `<b>${esc(brief.greeting)}</b>${sub}`;
}

export function greetingRich(brief: Brief): string {
  const count = brief.items.length;
  return [`# ${md(brief.greeting)}`, count ? `${count} ${count === 1 ? 'thing' : 'things'} worth your attention.` : 'A quiet cycle.'].join('\n\n');
}

function sourcesLine(item: BriefItem): string {
  return item.sources.map((s) => `<a href="${esc(s.url)}">${esc(s.publisher ?? s.title)}</a>`).join(' · ');
}

/** Lean per-item message body. No why-it-matters / signal / action / number. */
export function leanItemHtml(item: BriefItem): string {
  const label = item.is_update ? '<b>Update</b>\n' : item.matters_to_you === false ? '<i>Noticed, but ignore</i>\n' : '';
  const head = `${label}<b>${esc(item.headline)}</b>`;
  const summary = item.editorial_summary?.trim() || item.what_changed;
  return [head, esc(summary), sourcesLine(item)].filter(Boolean).join('\n');
}

export function leanItemRich(item: BriefItem): string {
  const summary = item.editorial_summary?.trim() || item.what_changed;
  const status = item.is_update ? '==UPDATE==' : item.matters_to_you === false ? '_Noticed, but low relevance_' : '';
  const sources = item.sources.map((source) => `[${md(source.publisher ?? source.title)}](${source.url})`).join(' · ');
  const image =
    item.image && /^https?:\/\//.test(item.image.url)
      ? `\n\n![](${item.image.url} "${md(item.image.credit ? `${item.image.alt} · ${item.image.credit}` : item.image.alt)}")`
      : '';
  return [status, `## ${md(item.headline)}`, md(summary), `---\n<footer>${sources}</footer>${image}`].filter(Boolean).join('\n\n');
}

/** Tap buttons per item (replaces "more 2" / "deep 2"). callback_data: m|d|s : storyId. */
export function itemKeyboard(item: BriefItem): InlineKeyboard {
  return [
    [
      { text: 'Expand', callback_data: `m:${item.id}` },
      { text: 'Deep dive', callback_data: `d:${item.id}` },
      { text: 'Sources', callback_data: `s:${item.id}` },
    ],
  ];
}

export function paperPreviewHtml(brief: Brief): string {
  const headlines = brief.items.map((item, index) => `${index + 1}. <b>${esc(item.headline)}</b>`);
  return [`<b>${esc(brief.greeting)}</b>`, ...headlines].join('\n\n');
}

export function paperPreviewRich(brief: Brief): string {
  const headlines = brief.items.map((item, index) => `${index + 1}. **${md(item.headline)}**`);
  return [`# ${md(brief.greeting)}`, ...headlines].join('\n\n');
}

export function paperFeedbackKeyboard(briefId: string): InlineKeyboard {
  return [[{ text: 'Good', callback_data: `bg:${briefId}` }, { text: 'Bad', callback_data: `bb:${briefId}` }]];
}

export function tailHtml(brief: Brief): string {
  const parts: string[] = [];
  if (brief.closing) parts.push(`<b>The bottom line</b>\n${esc(brief.closing)}`);
  else if (brief.quiet_note) parts.push(`<i>${esc(brief.quiet_note)}</i>`);
  return parts.join('\n\n');
}

export function tailRich(brief: Brief): string {
  const verdict = brief.closing ? `## The bottom line\n\n${md(brief.closing)}` : brief.quiet_note ? md(brief.quiet_note) : '';
  return verdict;
}

export function replyToHtml(reply: Reply): string {
  const parts: string[] = [];
  for (const b of reply.blocks) {
    switch (b.kind) {
      case 'text':
        parts.push(esc(b.text));
        break;
      case 'link':
        parts.push(`<a href="${esc(b.url)}">${esc(b.label)}</a>`);
        break;
      case 'list':
        parts.push((b.title ? `<b>${esc(b.title)}</b>\n` : '') + b.items.map((x) => `• ${esc(x)}`).join('\n'));
        break;
      case 'item':
        parts.push(`<b>${esc(b.item.headline)}</b>\n${esc(b.item.why_it_matters)}`);
        break;
      case 'confirm':
        parts.push(esc(b.prompt));
        break;
    }
  }
  return parts.join('\n\n');
}

function md(value: string): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/([*_~`[\]<>])/g, '\\$1')
    .replace(/—/g, ',');
}
