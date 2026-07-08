import { Router, Request, Response, NextFunction } from "express";
import { verifyJwt, verifyStudioOwnership, AuthError } from "../../lib/auth";
import { getServiceSupabase } from "../../lib/supabase";
import { encrypt, hmacSha256, generateSecureToken } from "../../lib/crypto";

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
      const { studioId, botToken, chatId, telegramMode } = req.body;

      if (!studioId) {
        return res.status(400).json({ error: "studioId is required" });
      }

      await verifyStudioOwnership(studioId, user.sub);

      const supabase = getServiceSupabase();

      // Generate a unique public webhook ID for this studio
      const publicWebhookId = generateSecureToken(16); // 32 hex chars

      // Generate a webhook secret for Telegram setWebhook
      const webhookSecret = generateSecureToken(32); // 64 hex chars

      // Encrypt bot token with AES-256-GCM
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

      // Return webhook URL and secret for user to configure in BotFather
      const apiDomain = process.env.API_DOMAIN || "api.yourdomain.com";
      return res.json({
        success: true,
        webhookUrl: `https://${apiDomain}/v1/telegram/webhook/${publicWebhookId}`,
        webhookSecret, // Plain secret — user needs this to call setWebhook
        message: "Use the webhookUrl and webhookSecret to configure your Telegram bot via setWebhook.",
      });
    } catch (err: any) {
      if (err instanceof AuthError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      next(err);
    }
  }
);
