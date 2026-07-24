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

  // ── Send a text message (with optional inline keyboard) ───────
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
          parse_mode: "Markdown",
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
}
