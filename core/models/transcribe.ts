import { env, requireOpenRouterKey } from '../../lib/env';
import { log } from '../../lib/log';

export const TRANSCRIPTION_MODEL = 'openai/whisper-large-v3-turbo';
const FALLBACK_TRANSCRIPTION_MODEL = 'google/gemini-2.5-flash';

export async function transcribeAudio(audio: Blob, filename = 'voice.ogg'): Promise<string> {
  const format = audioFormat(filename, audio.type);
  const data = Buffer.from(await audio.arrayBuffer()).toString('base64');

  const startedAt = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireOpenRouterKey()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': env.OPENROUTER_HTTP_REFERER,
      'X-Title': env.OPENROUTER_APP_TITLE,
    },
    body: JSON.stringify({
      model: TRANSCRIPTION_MODEL,
      input_audio: { data, format },
      language: 'en',
      temperature: 0,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  const raw = await response.text();
  let modelUsed = TRANSCRIPTION_MODEL;
  let text = response.ok ? transcriptionText(raw) : '';
  if (!text) {
    log.warn('transcription_primary_failed', { model: TRANSCRIPTION_MODEL, status: response.status, error: raw.slice(0, 500) });
    text = await transcribeWithAudioModel(data, format);
    modelUsed = FALLBACK_TRANSCRIPTION_MODEL;
  }
  text = text.trim();
  log.info('voice_transcribed', { model: modelUsed, chars: text.length, latencyMs: Date.now() - startedAt });
  if (!text) throw new Error('Transcription was empty');
  return text;
}

async function transcribeWithAudioModel(data: string, format: string): Promise<string> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireOpenRouterKey()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': env.OPENROUTER_HTTP_REFERER,
      'X-Title': env.OPENROUTER_APP_TITLE,
    },
    body: JSON.stringify({
      model: FALLBACK_TRANSCRIPTION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Transcribe this voice note exactly in its original language. Return only the transcript, with no preamble. Preserve names and technical terms. Likely vocabulary includes Winnow, Creed, Kram, hpbrn, OpenRouter, Railway, Telegram, Supabase, Postgres, MCP, Codex, and Claude.',
            },
            { type: 'input_audio', input_audio: { data, format } },
          ],
        },
      ],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const raw = await response.text();
  if (!response.ok) {
    log.error('transcription_fallback_failed', {
      model: FALLBACK_TRANSCRIPTION_MODEL,
      status: response.status,
      error: raw.slice(0, 500),
    });
    throw new Error(`Transcription fallback failed (${response.status})`);
  }
  try {
    const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
    return parsed.choices?.[0]?.message?.content?.trim() ?? '';
  } catch {
    return '';
  }
}

function transcriptionText(raw: string): string {
  try {
    return (JSON.parse(raw) as { text?: string }).text?.trim() ?? '';
  } catch {
    return raw.trim();
  }
}

function audioFormat(filename: string, mimeType: string): string {
  const extension = filename.toLowerCase().split('.').pop();
  if (extension && ['wav', 'mp3', 'aiff', 'aac', 'ogg', 'flac', 'm4a'].includes(extension)) return extension;
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  return 'ogg';
}
