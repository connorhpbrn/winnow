import { log } from '../lib/log';

// Minimal Telegram Bot API client over fetch (no SDK dependency). Used by the dev long-poll
// runner. HTML parse mode throughout (spec Section 12.1).

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}
export interface TgChat {
  id: number;
}
export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
export interface TgVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  document?: TgDocument;
  voice?: TgVoice;
  reply_to_message?: TgMessage;
  forward_date?: number;
  forward_origin?: unknown;
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

const MAX_LEN = 4000; // Telegram hard limit is 4096; leave headroom.

export class TelegramClient {
  constructor(private readonly token: string) {}

  private async api<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
    return json.result as T;
  }

  async getMe(): Promise<TgUser> {
    return this.api<TgUser>('getMe', {});
  }

  async getUpdates(offset: number, timeoutSec = 25): Promise<TgUpdate[]> {
    return this.api<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] });
  }

  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.api('setMyCommands', { commands });
  }

  /** Send HTML text, splitting on newlines into chunks under the length limit. Optional buttons. */
  async sendMessage(chatId: number, html: string, keyboard?: InlineKeyboard): Promise<void> {
    const chunks = splitForTelegram(html);
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      };
      if (keyboard && i === chunks.length - 1) body.reply_markup = { inline_keyboard: keyboard };
      await this.api('sendMessage', body);
    }
  }

  /** Bot API 10.1 rich messages, with an HTML fallback supplied by the caller. */
  async sendRichMessage(chatId: number, markdown: string, fallbackHtml: string, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await this.api('sendRichMessage', {
        chat_id: chatId,
        rich_message: { markdown, skip_entity_detection: true },
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    } catch (error) {
      log.warn('sendRichMessage_fallback', { error: (error as Error).message });
      await this.sendMessage(chatId, fallbackHtml, keyboard);
    }
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    try {
      await this.api('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
    } catch (e) {
      log.debug('answerCallbackQuery_failed', { error: (e as Error).message });
    }
  }

  /** Upload an in-memory file (the rendered newspaper edition). */
  async sendDocument(chatId: number, filename: string, content: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    form.append('document', new Blob([content], { type: 'text/html' }), filename);
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, { method: 'POST', body: form });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) throw new Error(`Telegram sendDocument failed: ${json.description ?? res.status}`);
  }

  /** Download a (text) file the user sent, returning its decoded text, or null if too big / unreadable. */
  async getFileText(fileId: string, maxBytes = 200_000): Promise<string | null> {
    try {
      const file = await this.api<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
      if (!file.file_path) return null;
      const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxBytes) return null;
      return new TextDecoder().decode(buf);
    } catch (e) {
      log.debug('getFileText_failed', { error: (e as Error).message });
      return null;
    }
  }

  async getFileBlob(fileId: string, maxBytes = 20_000_000): Promise<Blob | null> {
    try {
      const file = await this.api<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
      if (!file.file_path || (file.file_size != null && file.file_size > maxBytes)) return null;
      const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
      if (!res.ok) return null;
      const blob = await res.blob();
      return blob.size <= maxBytes ? blob : null;
    } catch (e) {
      log.debug('getFileBlob_failed', { error: (e as Error).message });
      return null;
    }
  }

  async sendChatAction(chatId: number, action = 'typing'): Promise<void> {
    try {
      await this.api('sendChatAction', { chat_id: chatId, action });
    } catch (e) {
      log.debug('sendChatAction_failed', { error: (e as Error).message });
    }
  }
}

function splitForTelegram(html: string): string[] {
  if (html.length <= MAX_LEN) return [html];
  const out: string[] = [];
  let current = '';
  for (const line of html.split('\n')) {
    if (current.length + line.length + 1 > MAX_LEN) {
      if (current) out.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) out.push(current);
  return out;
}
