import { Router, Request, Response, NextFunction } from "express";
import { verifyJwt, verifyStudioOwnership, AuthError } from "../../lib/auth";
import { getServiceSupabase } from "../../lib/supabase";
import { encrypt, decrypt, hmacSha256, generateSecureToken } from "../../lib/crypto";

export const secretsRouter = Router();

/**
 * POST /v1/studios/secrets
 * Saves encrypted Telegram bot token and hashed webhook secret.
 * Encryption key lives ONLY in ECS environment — never in database.
 */
secretsRouter.post(
  "/secrets",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await verifyJwt(req.headers.authorization);
      let { studioId, botToken, chatId, telegramMode } = req.body;

      if (!studioId) {
        return res.status(400).json({ error: "studioId is required" });
      }

      await verifyStudioOwnership(studioId, user.sub);

      const supabase = getServiceSupabase();

      // If botToken is not provided, fetch existing to keep webhook functional
      if (!botToken && telegramMode !== "none") {
        const { data: existingSec } = await supabase
          .from("studio_secrets")
          .select("encrypted_bot_token, iv, auth_tag, key_version")
          .eq("studio_id", studioId)
          .single();
          
        if (existingSec?.encrypted_bot_token) {
          botToken = decrypt(
            existingSec.encrypted_bot_token,
            existingSec.iv,
            existingSec.auth_tag,
            existingSec.key_version
          );
        }
      }

      // Generate a unique public webhook ID for this studio
      const publicWebhookId = generateSecureToken(16); // 32 hex chars

      // Generate a webhook secret for Telegram setWebhook
      const webhookSecret = generateSecureToken(32); // 64 hex chars

      // Encrypt bot token with AES-256-GCM (only if newly provided, otherwise we keep old one by not updating those columns)
      // Wait, if botToken was pulled from DB, encrypting it again is fine and refreshes the IV.
      let encryptedData = null;
      if (botToken) {
        encryptedData = encrypt(botToken);
      }

      // Hash webhook secret with HMAC-SHA256 for verification
      const webhookSecretHash = hmacSha256(webhookSecret);

      // Upsert into studio_secrets
      const secretsPayload: any = {
        studio_id: studioId,
        public_webhook_id: publicWebhookId,
        webhook_secret_hash: webhookSecretHash,
        updated_at: new Date().toISOString(),
      };

      if (encryptedData) {
        secretsPayload.encrypted_bot_token = encryptedData.ciphertext;
        secretsPayload.iv = encryptedData.iv;
        secretsPayload.auth_tag = encryptedData.auth_tag;
        secretsPayload.key_version = encryptedData.key_version;
      }

      // ECS Singapore can reach Telegram directly — no proxy needed. Always use direct URL.
      const frontendUrl = process.env.FRONTEND_URL || "https://acadlabs.fun";
      const webhookUrl = `${frontendUrl}/backend/v1/telegram/webhook/${publicWebhookId}`;
      const telegramApi = "https://api.telegram.org";

      // Step 1: Delete webhook to allow Long Polling to work
      if (botToken && telegramMode !== "none") {
        try {
          const tgRes = await fetch(`${telegramApi}/bot${botToken}/deleteWebhook`);
          
          const tgData = await tgRes.json();
          if (!tgData.ok) {
             console.warn("[Secrets] Telegram deleteWebhook returned false:", tgData);
          }
        } catch (tgErr: any) {
          console.error("[Secrets] Failed to contact Telegram API:", tgErr);
          return res.status(500).json({ error: "Failed to contact Telegram API to deleteWebhook" });
        }
      }

      // Step 1.5: Register the new webhook
      if (botToken && telegramMode !== "none") {
        try {
          const setRes = await fetch(`${telegramApi}/bot${botToken}/setWebhook`, {
            method: "POST",
            headers: { 
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              url: webhookUrl,
              secret_token: webhookSecret,
              allowed_updates: ["message", "edited_message", "callback_query"]
            })
          });
          
          const setData = await setRes.json();
          if (!setData.ok) {
            console.error("[Secrets] Telegram setWebhook failed:", setData);
            return res.status(400).json({ error: `Telegram Error: ${setData.description}` });
          }
        } catch (tgErr: any) {
          console.error("[Secrets] Failed to contact Telegram API for setWebhook:", tgErr);
          return res.status(500).json({ error: "Failed to contact Telegram API to setWebhook" });
        }
      }

      // Step 2: Only after setWebhook succeeds → upsert secrets to DB
      const { error: upsertErr } = await supabase
        .from("studio_secrets")
        .upsert(secretsPayload, { onConflict: "studio_id" });

      if (upsertErr) {
        console.error("[Secrets] Upsert error:", upsertErr);
        return res.status(500).json({ error: "Failed to save secrets" });
      }

      // Update studio metadata (non-secret fields)
      await supabase
        .from("studios")
        .update({
          telegram_chat_id: chatId || null,
          telegram_mode: telegramMode || "none",
          updated_at: new Date().toISOString(),
        })
        .eq("id", studioId);

      // Step 3: Post-save actions (setMyCommands + welcome message)
      if (botToken && telegramMode !== "none") {
        try {
          // Setup custom Telegram Menu commands
          await fetch(`${telegramApi}/bot${botToken}/setMyCommands`, {
            method: "POST",
            headers: { 
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              commands: [
                { command: "start", description: "Start using the bot" },
                { command: "help", description: "Show help & usage" },
                { command: "status", description: "Check current video render status" },
              ]
            })
          });
          
          // Send welcome message only after everything is confirmed working
          if (chatId) {
             await fetch(`${telegramApi}/bot${botToken}/sendMessage`, {
               method: "POST",
               headers: { 
                 "Content-Type": "application/json",
               },
               body: JSON.stringify({
                 chat_id: chatId,
                 text: "🎉 *Connection Successful!*\n\nYour AI Studio is now connected to this Telegram bot. Type /help to see the menu.",
                 parse_mode: "Markdown"
               })
             });
          }
        } catch (postErr: any) {
          // Non-fatal: webhook is already registered, commands/welcome are best-effort
          console.warn("[Secrets] Post-webhook actions failed:", postErr.message);
        }
      }

      return res.json({
        success: true,
        message: "Webhook successfully registered to Telegram automatically!",
      });
    } catch (err: any) {
      if (err instanceof AuthError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      next(err);
    }
  }
);
