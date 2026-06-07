import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Brief, BriefItem } from '../../core/schema/brief';

// Deterministic Brief -> HTML "digital newspaper" (the model never produces this). Dark mode,
// palette from Creed's dark theme, amber accent. Decluttered: signal + genre tags, headline,
// dense editorial copy, an optional useful image, an optional concrete watch line, and sources.
// Fonts embedded (base64 woff2) so it renders the exact typefaces everywhere, even offline.

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fonts');
function face(family: string, file: string, weight: number): string {
  try {
    const b64 = readFileSync(join(FONT_DIR, file)).toString('base64');
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
  } catch {
    return '';
  }
}
const FONT_FACES = [
  face('Instrument Serif', 'instrument-serif-400.woff2', 400),
  face('Geist', 'geist-400.woff2', 400),
  face('Geist', 'geist-500.woff2', 500),
  face('Geist', 'geist-600.woff2', 600),
].join('');

export function renderEditionHtml(brief: Brief): string {
  const items = brief.items.map(renderItem).join('\n');
  const conclusion = brief.closing
    ? `<div class="conclusion"><div class="bottomline">The bottom line</div><p>${esc(brief.closing)}</p></div>`
    : '';
  const body =
    brief.items.length === 0
      ? `<div class="quiet"><p>${esc(brief.quiet_note ?? 'A genuinely quiet cycle. Nothing that matters to you changed.')}</p></div>${conclusion}`
      : `${items}${conclusion}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Winnow Paper, ${esc(formatDate(brief.edition_date))}</title>
<style>${FONT_FACES}${CSS}</style>
</head>
<body>
<main>
  <header class="masthead">
    <h1 class="wordmark">Winnow Paper</h1>
    <div class="dateline">${esc(formatDate(brief.edition_date))}</div>
  </header>
  <section class="editions">
${body}
  </section>
  <footer class="colophon">Winnow Paper, a personal intelligence brief. This edition is private and expires.</footer>
</main>
</body>
</html>`;
}

function renderItem(item: BriefItem): string {
  // The composer is told to keep sources minimal; cap here as a safety net against noise.
  const sources = item.sources
    .slice(0, 3)
    .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.publisher ?? s.title)}</a>`)
    .join('<span class="dot">·</span>');

  const sig = item.signal_quality;
  const updateTag = item.is_update ? '<span class="tag tag-update">Update</span>' : '';
  const genreTags = safeGenres(item.genres)
    .map((g) => `<span class="tag" style="background:${g.color}26;color:${g.color}">${esc(g.label)}</span>`)
    .join('');
  const image = safeImage(item.image);
  const imageHtml = image
    ? `<figure class="visual"><img src="${esc(image.url)}" alt="${esc(image.alt)}" loading="lazy" referrerpolicy="no-referrer" />${image.credit ? `<figcaption>${esc(image.credit)}</figcaption>` : ''}</figure>`
    : '';
  const summary = item.editorial_summary?.trim() || fallbackSummary(item);
  const watch = item.watch_next?.trim()
    ? `<div class="watch"><p>${esc(item.watch_next.trim())}</p></div>`
    : '';

  return `    <article class="item">
      <div class="tags">${updateTag}<span class="tag tag-${sig}">${esc(cap(sig))} signal</span>${genreTags}</div>
      <h2 class="headline">${esc(item.headline)}</h2>
      ${imageHtml}
      <p class="summary">${esc(summary)}</p>
      ${watch}
      <div class="sources">${sources}</div>
    </article>`;
}

function fallbackSummary(item: BriefItem): string {
  const changed = item.what_changed.trim();
  const why = item.why_it_matters.trim();
  if (!why || changed.toLowerCase().includes(why.toLowerCase())) return changed;
  return `${changed} ${why}`;
}

function safeImage(image: BriefItem['image']): BriefItem['image'] | null {
  if (!image?.url || !image.alt?.trim()) return null;
  try {
    const url = new URL(image.url);
    if (url.protocol !== 'https:') return null;
    if (/(avatar|icon|logo|badge|emoji|tracking|pixel|spacer)/i.test(url.pathname)) return null;
    return image;
  } catch {
    return null;
  }
}

// Validate AI-picked colours and keep them legible on the dark canvas. Cap at 3 tags.
function safeGenres(genres: BriefItem['genres']): Array<{ label: string; color: string }> {
  if (!Array.isArray(genres)) return [];
  return genres
    .filter((g) => g?.label)
    .slice(0, 3)
    .map((g) => {
      let color = /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : '#f5a524';
      const r = parseInt(color.slice(1, 3), 16);
      const gg = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      if (0.2126 * r + 0.7152 * gg + 0.0722 * b < 90) color = '#f5a524';
      return { label: g.label, color };
    });
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  const day = d.getUTCDate();
  const month = d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return `${day} ${month} ${m[1]}`;
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CSS = `
:root {
  --bg: #0e0e0d;
  --fg: #e7e7e2;
  --body: #d6d6d0;
  --muted-fg: #9c9c95;
  --tertiary: #6b6b65;
  --border: #262624;
  --amber: #f5a524;
  --link: #f3b13b;
  --link-hover: #d6911e;
  --serif: 'Instrument Serif', Georgia, 'Times New Roman', serif;
  --sans: Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--sans);
  font-size: 18px;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
main { max-width: 640px; margin: 0 auto; padding: 80px 26px 120px; }

a { color: var(--link); text-decoration: none; transition: color 0.15s ease; }
a:hover { color: var(--link-hover); text-decoration: none; }

/* Masthead: the amber rule under the title is exactly the width of the title. */
.masthead { margin-bottom: 56px; }
.wordmark {
  display: inline-block;
  font-family: var(--serif);
  font-weight: 400;
  font-size: 66px;
  line-height: 1;
  white-space: nowrap;
  margin: 0;
  color: var(--fg);
  border-bottom: 3px solid var(--amber);
  padding-bottom: 14px;
}
.dateline { margin-top: 18px; font-size: 17px; font-weight: 500; color: var(--fg); }

/* No cards: items separated by space and a hairline rule. */
.item { padding: 0; }
.item + .item { margin-top: 46px; padding-top: 46px; border-top: 1px solid var(--border); }

/* Tag row: signal (traffic light) + AI-picked genre. */
.tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.tag { display: inline-block; padding: 2px 9px; border-radius: 6px; font-size: 13px; font-weight: 500; line-height: 1.5; }
.tag-high { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
.tag-medium { background: rgba(245, 165, 36, 0.16); color: var(--amber); }
.tag-low { background: rgba(248, 113, 113, 0.15); color: #f87171; }
.tag-update { background: rgba(94, 169, 255, 0.16); color: #5ea9ff; }

.headline { font-family: var(--serif); font-weight: 400; font-size: 33px; line-height: 1.14; margin: 0 0 12px; color: var(--fg); }
.summary { margin: 0 0 18px; color: var(--body); font-size: 17.5px; line-height: 1.68; }

.visual { margin: 18px 0 22px; }
.visual img {
  display: block;
  width: 100%;
  max-height: 390px;
  object-fit: cover;
  border-radius: 10px;
  background: var(--border);
}
.visual figcaption { margin-top: 8px; color: var(--tertiary); font-size: 12.5px; line-height: 1.4; }

.watch { margin: 3px 0 20px; padding-left: 15px; border-left: 2px solid var(--amber); }
.watch p { margin: 0; color: var(--body); font-size: 15.5px; line-height: 1.55; }

.sources { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14.5px; }
.sources a { font-weight: 500; }
.dot { color: var(--tertiary); }

/* Closing: "The bottom line" is a serif title, white, with an amber underline. */
.conclusion { margin-top: 52px; padding-top: 34px; border-top: 1px solid var(--border); }
.bottomline {
  display: inline-block;
  font-family: var(--serif);
  font-weight: 400;
  font-size: 32px;
  line-height: 1;
  color: var(--fg);
  border-bottom: 3px solid var(--amber);
  padding-bottom: 8px;
  margin-bottom: 20px;
}
.conclusion p { margin: 0; font-size: 18px; line-height: 1.6; color: var(--body); }

.quiet { text-align: center; padding: 72px 24px; color: var(--muted-fg); font-size: 23px; line-height: 1.5; font-family: var(--serif); }
.colophon { margin-top: 72px; padding-top: 22px; border-top: 1px solid var(--border); font-size: 13px; color: var(--tertiary); }
`;
