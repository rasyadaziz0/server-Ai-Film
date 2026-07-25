import { decrypt } from "../crypto";

// ── Types ────────────────────────────────────────────────────────
export interface BotSecrets {
  encrypted_bot_token: string;
  iv: string;
  auth_tag: string;
  key_version: number;
}

/**
 * TelegramBot — lightweight API wrapper for sending messages
 * and answering callback queries via the Telegram Bot API.
 *
 * Usage:
 *   const bot = new TelegramBot(secrets);
 *   await bot.sendMessage(chatId, "Hello!");
 *   await bot.sendMessage(chatId, "Pick one:", { inline_keyboard: [[...]] });
 */
export class TelegramBot {
  private readonly botToken: string;
  private readonly apiBase: string;
  private readonly relaySecret: string | undefined;

  constructor(secrets: BotSecrets) {
    this.botToken = decrypt(
      secrets.encrypted_bot_token,
      secrets.iv,
      secrets.auth_tag,
      secrets.key_version
    );
    this.apiBase = process.env.TELEGRAM_API_URL || "https://api.telegram.org";
    this.relaySecret = process.env.TELEGRAM_RELAY_SECRET;
  }

  async sendMessage(chatId: string, text: string, replyMarkup?: object): Promise<void> {
    try {
      await fetch(`${this.apiBase}/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.relaySecret ? { "x-relay-secret": this.relaySecret } : {}),
        },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      });
    } catch (e: any) {
      console.error("[TelegramBot] Failed to send message:", e.message);
    }
  }

  // ── Answer a callback query (removes loading spinner) ─────────
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await fetch(`${this.apiBase}/bot${this.botToken}/answerCallbackQuery`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.relaySecret ? { "x-relay-secret": this.relaySecret } : {}),
        },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          ...(text ? { text, show_alert: false } : {}),
        }),
      });
    } catch (e: any) {
      console.error("[TelegramBot] Failed to answer callback query:", e.message);
    }
  }

  // ── Send media by URL (up to 20MB fetched by Telegram) ───────
  async sendMediaByUrl(chatId: string, apiMethod: string, url: string, caption?: string): Promise<void> {
    const payload: any = { chat_id: chatId, caption };
    if (apiMethod === "sendVideo") payload.video = url;
    else if (apiMethod === "sendAudio") payload.audio = url;
    else if (apiMethod === "sendPhoto") payload.photo = url;
    else payload.document = url;

    const res = await fetch(`${this.apiBase}/bot${this.botToken}/${apiMethod}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.relaySecret ? { "x-relay-secret": this.relaySecret } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Telegram URL send failed (HTTP ${res.status}): ${errBody}`);
    }
  }

  // ── Send media multipart (fallback, bypass proxy for >4.5MB) ───────
  async sendMediaMultipart(chatId: string, apiMethod: string, blob: Blob, filename: string, caption?: string): Promise<void> {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    if (caption) formData.append("caption", caption);
    
    let fileField = "document";
    if (apiMethod === "sendVideo") fileField = "video";
    else if (apiMethod === "sendAudio") fileField = "audio";
    else if (apiMethod === "sendPhoto") fileField = "photo";
    
    formData.append(fileField, blob, filename);

    // Bypass Vercel proxy for multipart to avoid 4.5MB Vercel body limit
    const directApiBase = "https://api.telegram.org";

    const res = await fetch(`${directApiBase}/bot${this.botToken}/${apiMethod}`, {
      method: "POST",
      body: formData, // FormData fetch automatically sets correct content-type with boundary
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Telegram multipart send failed (HTTP ${res.status}): ${errBody}`);
    }
  }
}
