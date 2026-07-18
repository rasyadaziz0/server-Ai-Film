import { Router, Request, Response, NextFunction } from "express";
import { getServiceSupabase } from "../../lib/supabase";
import { constantTimeEqual, decrypt, hmacSha256 } from "../../lib/crypto";
import { checkKillSwitch, KillSwitchError } from "../../lib/killSwitch";
import { estimatePipelineCost, getDailyLimitMicroUsd } from "../../lib/budget";

export const telegramRouter = Router();

/**
 * POST /v1/telegram/webhook/:publicWebhookId
 * Receives Telegram webhook updates.
 * Uses publicWebhookId to identify the studio (no secrets in URL).
 */
telegramRouter.post(
  "/webhook/:publicWebhookId",
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const { publicWebhookId } = req.params;
      const secretToken = req.headers["x-telegram-bot-api-secret-token"] as string | undefined;

      if (!publicWebhookId || !secretToken) {
        return res.status(403).send("Forbidden");
      }

      const supabase = getServiceSupabase();

      // 1. Find studio secrets by publicWebhookId
      const { data: secrets, error: secretsErr } = await supabase
        .from("studio_secrets")
        .select("studio_id, webhook_secret_hash, encrypted_bot_token, iv, auth_tag, key_version")
        .eq("public_webhook_id", publicWebhookId)
        .single();

      if (secretsErr || !secrets) {
        return res.status(403).send("Invalid webhook");
      }

      // 2. Constant-time verify webhook secret
      const incomingHash = hmacSha256(secretToken);
      if (!secrets.webhook_secret_hash || !constantTimeEqual(incomingHash, secrets.webhook_secret_hash)) {
        return res.status(403).send("Invalid secret");
      }

      // 3. Get studio info
      const { data: studio, error: studioErr } = await supabase
        .from("studios")
        .select("id, user_id, telegram_chat_id, telegram_mode, video_duration")
        .eq("id", secrets.studio_id)
        .single();

      if (studioErr || !studio) {
        return res.status(403).send("Studio not found");
      }

      const chatId = req.body.message?.chat?.id?.toString() || req.body.edited_message?.chat?.id?.toString();
      const text = req.body.message?.text || req.body.edited_message?.text;
      const updateId = req.body.update_id?.toString();

      if (!chatId) {
        return res.sendStatus(200);
      }

      // 4. Verify allowed Chat ID (Security)
      if (studio.telegram_chat_id && studio.telegram_chat_id !== chatId) {
        console.log(`[Telegram] Unauthorized Chat ID: ${chatId}`);
        return res.sendStatus(200);
      }

      // 5. Check if it's a command
      if (text && text.startsWith("/")) {
        if (text === "/start" || text === "/help") {
          await sendTelegramMessage(
            secrets, supabase,
            chatId,
            "🎬 *Welcome to AI Film Studio!*\n\nKetik ide cerita atau prompt apa saja di sini, dan sistem kami akan otomatis membuatkan naskah dan videonya untuk Anda.\n\nContoh: _Bikin video tentang T-Rex yang main piano di bulan_\n\n*Command lain:*\n/status - Cek status render video terakhir\n/duration <detik> - Ubah durasi video (5, 15, 30)\n/lang <bahasa> - Ubah bahasa (id, en, dll)"
          );
        } else if (text === "/status") {
          // Check last job status
          const { data: lastJob } = await supabase
            .from("jobs")
            .select("status, result_url, error")
            .eq("studio_id", studio.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
            
          let statusMsg = "Belum ada job video yang berjalan di studio ini.";
          if (lastJob) {
             if (lastJob.status === "done") statusMsg = `✅ *Selesai!* Video terakhir Anda sudah jadi: ${lastJob.result_url}`;
             else if (lastJob.status === "error") statusMsg = `❌ *Gagal:* ${lastJob.error}`;
             else statusMsg = `⏳ *Status:* Sedang diproses (${lastJob.status})... Mohon tunggu.`;
          }
          await sendTelegramMessage(secrets, supabase, chatId, statusMsg);
        } else if (text.startsWith("/duration")) {
          const secs = parseInt(text.split(" ")[1]);
          if ([5, 15, 30].includes(secs)) {
            await supabase.from("studios").update({ video_duration: secs }).eq("id", studio.id);
            await sendTelegramMessage(secrets, supabase, chatId, `✅ Durasi video berhasil diubah menjadi *${secs} detik*.`);
          } else {
            await sendTelegramMessage(secrets, supabase, chatId, `⚠️ Format salah. Contoh: /duration 15\n(Pilihan: 5, 15, 30)`);
          }
        } else if (text.startsWith("/lang") || text.startsWith("/bahasa")) {
          const lang = text.split(" ")[1];
          if (lang) {
            await supabase.from("studios").update({ language: lang }).eq("id", studio.id);
            await sendTelegramMessage(secrets, supabase, chatId, `✅ Bahasa berhasil diubah menjadi: *${lang}*`);
          } else {
            await sendTelegramMessage(secrets, supabase, chatId, `⚠️ Format salah. Contoh: /lang id\nAtau /lang en`);
          }
        } else {
           await sendTelegramMessage(secrets, supabase, chatId, `⚠️ Command tidak dikenali. Ketik /help untuk daftar command.`);
        }
        return res.sendStatus(200);
      }

      // 6. Dedup update_id BEFORE sending "processing" message
      //    Check if this update_id was already processed
      if (updateId) {
        const { data: existingJob } = await supabase
          .from("jobs")
          .select("id")
          .eq("studio_id", studio.id)
          .eq("source", "telegram")
          .eq("external_event_id", updateId)
          .maybeSingle();

        if (existingJob) {
          console.log(`[Telegram] Duplicate update_id ${updateId}, skipping`);
          return res.sendStatus(200);
        }
      }

      // 7. Kill switch check BEFORE any work
      try {
        checkKillSwitch();
      } catch (e) {
        if (e instanceof KillSwitchError) {
          await sendTelegramMessage(
            secrets, supabase,
            chatId,
            "⚠️ AI generation is currently paused. Please try again later."
          );
          return res.sendStatus(200);
        }
        throw e;
      }

      // 8. Atomic RPC: create job + reserve budget + insert outbox
      const estimatedCost = estimatePipelineCost(studio.video_duration || 5);
      const { data: rpcResult, error: rpcError } = await supabase.rpc(
        "create_job_and_reserve",
        {
          p_studio_id: studio.id,
          p_user_id: studio.user_id, // Pass user_id for budget checking
          p_source: "telegram",
          p_input: text,
          p_external_event_id: updateId,
          p_estimated_cost: estimatedCost,
          p_daily_limit: getDailyLimitMicroUsd(),
          p_chat_id: chatId,
        }
      );

      if (rpcError) {
        console.error("[Telegram] RPC error:", rpcError);
        return res.sendStatus(200);
      }

      const result = rpcResult as any;

      if (result.error === "daily_budget_exceeded") {
        await sendTelegramMessage(
          secrets, supabase,
          chatId,
          "⚠️ Daily budget exceeded. Please try again tomorrow."
        );
        return res.sendStatus(200);
      }

      if (result.error === "active_job_exists") {
        await sendTelegramMessage(
          secrets, supabase,
          chatId,
          "⏳ Studio already has an active job. Please wait for it to finish."
        );
        return res.sendStatus(200);
      }

      if (result.duplicate) {
        return res.sendStatus(200);
      }

      // 9. Now safe to send "processing" message (after dedup and budget check)
      await sendTelegramMessage(
        secrets, supabase,
        chatId,
        `⏳ Processing your idea: "${text}"...`
      );

      // Job is in outbox, dispatcher will enqueue to BullMQ
      return res.sendStatus(200);
    } catch (error: any) {
      console.error("[Telegram Webhook Error]", error);
      return res.sendStatus(200); // Always 200 to prevent Telegram retries
    }
  }
);

/**
 * Sends a Telegram message using the encrypted bot token.
 */
async function sendTelegramMessage(
  secrets: { encrypted_bot_token: string; iv: string; auth_tag: string; key_version: number },
  _supabase: any,
  chatId: string,
  text: string
): Promise<void> {
  try {
    const botToken = decrypt(
      secrets.encrypted_bot_token,
      secrets.iv,
      secrets.auth_tag,
      secrets.key_version
    );

    const telegramApi = process.env.TELEGRAM_API_URL || "https://api.telegram.org";
    await fetch(`${telegramApi}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
      })
    });
  } catch (e: any) {
    console.error("[Telegram] Failed to send message:", e.message);
  }
}
