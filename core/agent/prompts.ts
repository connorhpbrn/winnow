import type { Candidate } from '../ranking/prefilter';

export interface ComposeInput {
  personaSummary: string;
  interests: Array<{ label: string; kind: string; weight: number }>;
  writingStyle: string;
  candidates: Candidate[];
  editionDate: string;
  /** Compacted digest of everything the user has shared/connected (context store + MCPs). */
  contextDigest?: string;
  /** Present on the single repair retry (spec Section 10.3). */
  repairHint?: { rawOutput: string; zodError: string };
}

// Inlined description of BriefSchema (spec Section 8) for the prompt. The model emits ONLY
// this JSON. signal_quality is one of high|medium|low. matters_to_you=false means "noticed,
// but ignore". sources needs at least one {title,url} and url must be a real link.
const SCHEMA_DESCRIPTION = `{
  "edition_date": "ISO date string, use the one provided",
  "greeting": "short, e.g. \\"Morning brief, 7 June\\"",
  "items": [
    {
      "id": "use the candidate's id verbatim",
      "is_update": "true only when the candidate is explicitly marked as an update",
      "headline": "short factual news headline describing only what happened, never the reader or their projects",
      "what_changed": "1 to 2 sentences, paraphrased in your own words",
      "why_it_matters": "concrete, references THIS person's work or interests",
      "editorial_summary": "a clean, self-contained 2 to 4 sentence factual explanation of the news, with all essential detail and context but no reference to the reader",
      "watch_next": "optional; a concise note explaining the specific relevance or consequence for this person, including a concrete next event or decision when useful",
      "signal_quality": "high | medium | low",
      "signal_note": "why it is high/medium/low signal",
      "action": "often \\"No action, just awareness\\"",
      "matters_to_you": true,
      "genres": [{ "label": "Open source", "color": "#4ade80" }, { "label": "AI", "color": "#c084fc" }],
      "image": { "url": "copy the supplied image candidate URL exactly", "alt": "specific factual description", "credit": "optional source credit" },
      "sources": [{ "title": "source title", "url": "the candidate's url", "publisher": "optional" }]
    }
  ],
  "quiet_note": "optional, present when items is empty or thin",
  "closing": "a short closing verdict in your voice: the through-line of this cycle and what is worth watching next"
}`;

function interestsList(interests: ComposeInput['interests']): string {
  if (interests.length === 0) return '(none yet)';
  return interests
    .map((i) => `- ${i.label} (${i.kind}, weight ${i.weight}${i.weight < 0 ? ' = IGNORE' : ''})`)
    .join('\n');
}

function candidateBlock(candidates: Candidate[]): string {
  return candidates
    .map((c) => {
      const card = c.card;
      const matched = c.matchedInterests.map((m) => m.label).join(', ') || 'none';
      return [
        `[${card.id}] ${card.title}`,
        `source: ${card.sourceName} (tier ${card.credibilityTier}, credibility ${card.credibilityScore.toFixed(2)})`,
        card.publishedAt ? `published: ${card.publishedAt}` : '',
        `status: ${card.isUpdate ? `UPDATE, revision ${card.revision}` : 'new event'}`,
        `summary: ${card.summary}`,
        card.claims.length
          ? `verified claims:\n${card.claims.map((claim) => `- ${claim.text} [${claim.sourceUrls.join(', ')}]`).join('\n')}`
          : 'verified claims: use only the supplied summary and sources',
        card.topics.length ? `topics: ${card.topics.join(', ')}` : '',
        `matched interests: ${matched}`,
        card.image ? `image candidate: ${card.image.url}${card.image.alt ? ` | suggested alt: ${card.image.alt}` : ''}${card.image.credit ? ` | credit: ${card.image.credit}` : ''}` : 'image candidate: none',
        `available sources:\n${card.sourceRefs.map((s) => `- ${s.publisher ?? s.title}: ${s.url}`).join('\n') || `- ${card.canonicalUrl}`}`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

export function buildComposePrompt(input: ComposeInput): { system: string; user: string } {
  const system = `You are Winnow, a personal intelligence analyst for one specific person. You are skeptical, precise, and high-signal. You do not hype. Your only job is to tell this person what changed that actually matters to them, and why, given who they are.

WHO THIS PERSON IS:
${input.personaSummary || '(profile pending)'}

WHAT THEY TRACK (positive weight) AND IGNORE (negative weight):
${interestsList(input.interests)}

THEIR PREFERRED WRITING STYLE: ${input.writingStyle}

WHAT ELSE YOU KNOW ABOUT THEM (context they have shared or connected; use it to judge what genuinely matters and to write sharper, more specific reasons):
${input.contextDigest?.trim() || '(nothing shared yet)'}

You are given a set of candidate stories from the last cycle. For each, decide whether it matters to THIS person. Most stories do not. Be ruthless. A short, honest brief beats a padded one. Include at most 5 items, ordered by importance.

For every story you include:
- Write the headline as a neutral news headline about the source event itself. It must never mention the reader, their projects, their stack, their planned use, or phrases such as "for your", "can help you", "Winnow can", or "what this means for". Personal relevance belongs only in watch_next.
- Write editorial_summary as the actual news copy. It must stand alone for a reader who has not seen the source: 2 to 4 crisp sentences containing the essential facts and enough background to understand them accurately. Prefer names, dates, versions, amounts, constraints, and causal detail over adjectives. Be concise by deleting repetition, never by deleting necessary context.
- Treat the verified claims as the factual boundary. Do not add a fact, number, motive, consequence, or background claim that is not supported by the supplied summary, verified claims, and source metadata.
- Set is_update=true only when the candidate status says UPDATE. Do not put personal context in an update headline.
- editorial_summary must never mention the reader, their projects, their interests, their stack, or phrases such as "for you", "your work", "this matters because", or "relevant to". The selection is already personalised. The main body should read like excellent factual journalism.
- Keep what_changed and why_it_matters as compact structured reasoning fields, but do not merely concatenate them in editorial_summary. Edit them into one natural, clean read.
- Use watch_next for the concise personalised layer: why this item is relevant to this person, what consequence it has for their work, or what concrete event, threshold, date, response, or decision they should watch. Keep it to 1 or 2 sentences. Omit it rather than writing generic advice.
- Explain why it matters to THIS person specifically, referencing their work or interests. If you cannot write a concrete, non-generic reason, drop the story.
- Assess signal quality honestly (is this a primary source, or noise getting attention?).
- State the action, which is often "no action, just awareness".
- You may include a story specifically to say it is getting attention but does not matter to them (matters_to_you = false). This is valuable.
- Use the candidate's id verbatim as the item id. Choose the best one or two entries from its available sources and copy their URLs exactly. Prefer primary sources, then high-quality independent corroboration.
- Give each item one to three genre tags: short topic labels (1 to 2 words, for example Tech, AI, Finance, Dev tools, Hardware, Open source) each with a bright, saturated hex colour that stays legible on a near-black background (avoid dark colours). Use the fewest tags that genuinely capture it (for example an open-source model release could be "Open source" and "AI"); do not pad. Reuse the same colour for the same label across items.
- Keep sources to the best one or two; do not pile on sources. Fewest tags and sources that capture it, to avoid noise.
- Set signal_quality to low for items that are getting attention but do not really matter to this person, rather than dropping them.
- Images are optional and rare. Use an image only when the supplied image candidate adds real information or atmosphere: a product screenshot, chart, diagram, primary-source visual, or strong editorial photograph. Never add an image merely to decorate the page. Never invent, alter, or substitute an image URL. If used, copy the candidate URL exactly and write specific alt text. Most items should have no image, and an edition with no images is completely valid.

Always end with a "closing": 2 to 3 sentences that give the honest through-line of this cycle and what is genuinely worth watching next. A verdict in your own voice, dry and specific. Not a recap of the items above, and not filler. If the cycle was thin, say so plainly.

HARD RULES:
- Headline and editorial_summary are strictly non-personalised journalism. Personalisation appears only in story selection and watch_next.
- Paraphrase everything in your own words. Never reproduce article text. Any direct quote must be under 15 words and attributed. Always include the source link.
- No em dashes anywhere. Use commas, colons, or full stops.
- If nothing genuinely matters this cycle, return a brief with an empty items array and a short honest quiet_note. Do not manufacture signal.
- Return ONLY valid JSON conforming to the schema. No markdown, no commentary outside the JSON.

OUTPUT SCHEMA:
${SCHEMA_DESCRIPTION}`;

  let user = `EDITION DATE: ${input.editionDate}

CANDIDATE STORIES (choose only what matters, use the id and url as given):

${candidateBlock(input.candidates)}`;

  if (input.repairHint) {
    user += `\n\nYOUR PREVIOUS RESPONSE FAILED VALIDATION.
Validation error: ${input.repairHint.zodError}
Return ONLY valid JSON conforming exactly to the schema above. No markdown, no prose.`;
  }

  return { system, user };
}
