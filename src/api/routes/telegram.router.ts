import { Router, Request, Response, NextFunction } from "express";
import { getServiceSupabase } from "../../lib/supabase";
import { constantTimeEqual, hmacSha256 } from "../../lib/crypto";
import { checkKillSwitch, KillSwitchError } from "../../lib/killSwitch";
import { estimatePipelineCost, getDailyLimitMicroUsd } from "../../lib/budget";
import { TelegramBot } from "../../lib/telegram/TelegramBot";
import { TelegramHandler } from "../../lib/telegram/TelegramHandler";

export const telegramRouter = Router();

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

      // ── 1. Lookup studio secrets ──
      const { data: secrets, error: secretsErr } = await supabase
        .from("studio_secrets")
        .select("studio_id, webhook_secret_hash, encrypted_bot_token, iv, auth_tag, key_version")
        .eq("public_webhook_id", publicWebhookId)
        .single();

      if (secretsErr || !secrets) return res.status(403).send("Invalid webhook");

      // ── 2. Verify HMAC ──
      const incomingHash = hmacSha256(secretToken);
      if (!secrets.webhook_secret_hash || !constantTimeEqual(incomingHash, secrets.webhook_secret_hash)) {
        return res.status(403).send("Invalid secret");
      }

      // ── 3. Fetch studio ──
      const { data: studio, error: studioErr } = await supabase
        .from("studios")
        .select("id, user_id, telegram_chat_id, telegram_mode, video_duration")
        .eq("id", secrets.studio_id)
        .single();

      if (studioErr || !studio) return res.status(403).send("Studio not found");

      // ── Instantiate Bot & Handler ──
      const bot = new TelegramBot(secrets);
      const handler = new TelegramHandler(bot, supabase, studio);

      // ══════════════════════════════════════════════════════════
      //  A) CALLBACK QUERY (inline keyboard click)
      // ══════════════════════════════════════════════════════════
      const callbackQuery = req.body.callback_query;
      if (callbackQuery) {
        const cbChatId = callbackQuery.message?.chat?.id?.toString();
        const cbData = callbackQuery.data as string | undefined;
        const cbId = callbackQuery.id as string;

        if (!cbChatId || !cbData) {
          await bot.answerCallbackQuery(cbId);
          return res.sendStatus(200);
        }

        // Chat ID allowlist
        if (studio.telegram_chat_id && studio.telegram_chat_id !== cbChatId) {
          await bot.answerCallbackQuery(cbId);
          return res.sendStatus(200);
        }

        await handler.handleCallback(cbChatId, cbData, cbId);
        return res.sendStatus(200);
      }

      // ══════════════════════════════════════════════════════════
      //  B) REGULAR MESSAGE
      // ══════════════════════════════════════════════════════════
      const chatId = req.body.message?.chat?.id?.toString() || req.body.edited_message?.chat?.id?.toString();
      const text = req.body.message?.text || req.body.edited_message?.text;
      const updateId = req.body.update_id?.toString();

      if (!chatId) return res.sendStatus(200);

      // Chat ID allowlist
      if (studio.telegram_chat_id && studio.telegram_chat_id !== chatId) {
        return res.sendStatus(200);
      }

      // ── B1) Commands ──
      if (text && text.startsWith("/")) {
        const [cmd, ...args] = text.split(" ");
        const arg = args.join(" ") || undefined;

        switch (cmd) {
          case "/start":
          case "/help":
            await handler.handleStart(chatId);
            break;
          case "/status":
            await handler.handleStatus(chatId);
            break;
          case "/duration":
            await handler.handleDuration(chatId, arg);
            break;
          case "/lang":
          case "/bahasa":
            await handler.handleLang(chatId, arg);
            break;
          default:
            await handler.handleUnknownCommand(chatId);
        }
        return res.sendStatus(200);
      }

      // ── B2) Prompt → create pipeline job ──
      // Dedup
      if (updateId) {
        const { data: existingJob } = await supabase
          .from("jobs")
          .select("id")
          .eq("studio_id", studio.id)
          .eq("source", "telegram")
          .eq("external_event_id", updateId)
          .maybeSingle();

        if (existingJob) return res.sendStatus(200);
      }

      // Kill switch
      try {
        checkKillSwitch();
      } catch (e) {
        if (e instanceof KillSwitchError) {
          await bot.sendMessage(chatId, "⚠️ AI generation is currently paused. Please try again later.");
          return res.sendStatus(200);
        }
        throw e;
      }

      // Atomic RPC: create job + reserve budget + insert outbox
      const estimatedCost = estimatePipelineCost(studio.video_duration || 5);
      const { data: rpcResult, error: rpcError } = await supabase.rpc(
        "create_job_and_reserve",
        {
          p_studio_id: studio.id,
          p_user_id: studio.user_id,
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
        await bot.sendMessage(chatId, "⚠️ Daily budget exceeded. Please try again tomorrow.");
        return res.sendStatus(200);
      }

      if (result.error === "active_job_exists") {
        await bot.sendMessage(chatId, "⏳ Studio already has an active job. Please wait for it to finish.");
        return res.sendStatus(200);
      }

      if (result.duplicate) return res.sendStatus(200);

      await bot.sendMessage(chatId, `⏳ Processing your idea: "${text}"...`);
      return res.sendStatus(200);
    } catch (error: any) {
      console.error("[Telegram Webhook Error]", error);
      return res.sendStatus(200);
    }
  }
);
