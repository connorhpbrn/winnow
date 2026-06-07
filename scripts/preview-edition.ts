import { writeFileSync, mkdirSync } from 'node:fs';
import { renderEditionHtml } from '../lib/edition/render';
import type { Brief } from '../core/schema/brief';

// A realistic full edition for design iteration, with selective imagery and varied depth.
const brief: Brief = {
  edition_date: '2026-06-14',
  greeting: 'Morning brief, 14 June',
  items: [
    {
      id: '1',
      is_update: true,
      headline: 'Coding tools are becoming programmable agent runtimes',
      what_changed: 'Coding agents are adding hooks, reusable subagents, and tighter permission controls.',
      why_it_matters: 'You build context infrastructure for agents and have just moved Winnow from Claude Code to Codex.',
      editorial_summary:
        'Coding tools are moving beyond single chat sessions toward programmable agent runtimes, with deterministic hooks, reusable subagents, and narrower permission boundaries. Hooks let teams run fixed commands around tool calls, while subagents can carry specialised prompts and restricted capabilities. The broader shift is from one general coding assistant toward systems of smaller workers coordinated inside the development environment.',
      watch_next:
        'This strengthens the case for Creed as the context layer across execution surfaces. Watch whether these configurations gain durable shared memory or remain repository-local.',
      signal_quality: 'high',
      signal_note: 'Primary product documentation and a clear strategic direction across coding tools.',
      action: 'Keep Winnow on its current path and compare the emerging context and permission models.',
      matters_to_you: true,
      genres: [
        { label: 'AI agents', color: '#c084fc' },
        { label: 'Dev tools', color: '#5ea9ff' },
      ],
      image: {
        url: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1400&q=85',
        alt: 'A developer working with code across a laptop and external display.',
        credit: 'Illustrative image',
      },
      sources: [
        { title: 'Claude Code hooks', url: 'https://docs.anthropic.com/en/docs/claude-code/hooks', publisher: 'Anthropic' },
        { title: 'Codex', url: 'https://openai.com/codex/', publisher: 'OpenAI' },
      ],
    },
    {
      id: '2',
      headline: 'Railway scheduled jobs run commands inside existing services',
      what_changed: 'Railway supports scheduled commands using the same project image and environment as the main service.',
      why_it_matters: 'Winnow needs recurring ingestion and local-time brief delivery before it can run unattended.',
      editorial_summary:
        'Railway scheduled jobs can run commands against the same image and environment as an existing service. A cron schedule starts a service for each run, executes its configured command, and exits when the process completes. This is suited to recurring ingestion, cleanup, and scheduler sweeps without requiring a separate workflow platform.',
      watch_next:
        'Winnow can use this for 30-minute ingestion and a 15-minute delivery sweep. Implement `selectDueAccounts(now)` and edition cleanup before deployment.',
      signal_quality: 'high',
      signal_note: 'Direct platform capability relevant to Winnow’s chosen production architecture.',
      action: 'Use Railway cron for ingestion and a scheduler sweep.',
      matters_to_you: true,
      genres: [
        { label: 'Infrastructure', color: '#38bdf8' },
        { label: 'Winnow', color: '#f5a524' },
      ],
      sources: [{ title: 'Cron jobs', url: 'https://docs.railway.com/reference/cron-jobs', publisher: 'Railway' }],
    },
    {
      id: '3',
      headline: 'MCP authorization is settling around standard OAuth and PKCE',
      what_changed: 'Remote MCP servers now have a clearer OAuth-based path for dynamic clients and refreshable access.',
      why_it_matters: 'Winnow already connects to Creed, but its local callback cannot complete authorization from a phone.',
      editorial_summary:
        'The emerging MCP authorization pattern uses standard OAuth discovery, dynamic client registration, PKCE, and refresh tokens instead of custom key exchanges. A client discovers authorization metadata, registers when necessary, opens the user’s browser, and exchanges the returned code for refreshable access. The approach gives remote MCP servers a conventional security model while allowing dynamically created clients.',
      watch_next:
        'Winnow already follows most of this flow. Its remaining blocker is the localhost callback, which must move to a hosted URL for authorization from Telegram on a phone.',
      signal_quality: 'medium',
      signal_note: 'The protocol direction is clear, but server implementations and scopes still vary.',
      action: 'Keep the current OAuth implementation and replace the callback surface during deployment.',
      matters_to_you: true,
      genres: [
        { label: 'MCP', color: '#4ade80' },
        { label: 'Auth', color: '#fb7185' },
      ],
      sources: [
        {
          title: 'MCP authorization',
          url: 'https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization',
          publisher: 'Model Context Protocol',
        },
      ],
    },
    {
      id: '4',
      headline: 'Agent token costs increasingly point back to context quality',
      what_changed: 'New evaluations are separating useful generation from repeated retrieval and context overhead.',
      why_it_matters: 'Creed’s value depends on supplying durable context without repeatedly flooding models.',
      editorial_summary:
        'Recent evaluations attribute a meaningful share of coding-agent token spend to repeatedly retrieved context rather than final generation. The measurements separate tokens used for tool results and repeated repository context from those used to produce the final answer or patch. They also show that lower token use alone is not evidence of a better system, because retrieval quality and task success can move in the opposite direction.',
      watch_next:
        'This supports Creed’s emphasis on compact, durable context, but it is not yet a product claim. Look for production comparisons that measure task success as well as cost.',
      signal_quality: 'medium',
      signal_note: 'Useful early methodology, not settled production evidence.',
      action: 'Use it as a design signal, not a public product claim.',
      matters_to_you: true,
      genres: [
        { label: 'Research', color: '#60a5fa' },
        { label: 'Creed', color: '#818cf8' },
      ],
      sources: [{ title: 'Agent systems research', url: 'https://arxiv.org/', publisher: 'arXiv' }],
    },
    {
      id: '5',
      headline: 'Apple previews more consumer AI without a useful agent surface',
      what_changed: 'Apple previewed additional AI-assisted features across its operating systems.',
      why_it_matters: 'The announcement is widely discussed but has no immediate consequence for your active products.',
      editorial_summary:
        'Apple has previewed another set of AI-assisted features across its operating systems, including expanded writing, image, and system-level assistance. The announcement remains focused on first-party user experiences rather than a broad third-party agent platform. Details around durable context, external tool access, and developer control are still limited.',
      watch_next:
        'There is no immediate consequence for Winnow, Creed, or Kram. Revisit this only when Apple exposes a concrete developer or agent surface.',
      signal_quality: 'low',
      signal_note: 'A primary announcement with low relevance until the developer surface becomes concrete.',
      action: 'No action, just awareness.',
      matters_to_you: false,
      genres: [
        { label: 'Apple', color: '#a3a3a3' },
        { label: 'Consumer AI', color: '#f472b6' },
      ],
      sources: [{ title: 'Apple Intelligence', url: 'https://www.apple.com/apple-intelligence/', publisher: 'Apple' }],
    },
  ],
  quiet_note: 'The rest of the cycle was mostly routine framework releases and consumer AI commentary without a direct consequence for your work.',
  closing:
    'The useful thread today is infrastructure becoming less bespoke: coding tools are gaining agent primitives, Railway can handle the recurring jobs, and MCP is settling on standard authorization. None of that changes Winnow’s immediate priority. Make the paper excellent, then deploy the smallest production loop that keeps its sources fresh and delivers it reliably.',
};

mkdirSync('editions', { recursive: true });
const html = renderEditionHtml(brief);
writeFileSync('editions/preview-dark.html', html);
console.log(`wrote editions/preview-dark.html | ${Math.round(html.length / 1024)} KB`);
