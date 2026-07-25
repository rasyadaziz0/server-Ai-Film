import "dotenv/config";
import { startOutboxDispatcher } from "./outboxDispatcher";
import { startPipelineWorker } from "./pipelineWorker";
import { getServiceSupabase } from "../lib/supabase";
import { startTelegramPollWorker } from "./telegramPollWorker";

/**
 * Watchdog: Every 1 minute, finds jobs stuck in 'running' 
 * whose heartbeat is older than 3 minutes.
 * Marks them as error, zeroes reserved budget, and notifies Telegram if applicable.
 */
function startWatchdog() {
  console.log("[Watchdog] Started");
  setInterval(async () => {
    try {
      const supabase = getServiceSupabase();
      const staleThreshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();

      const { data: stuckJobs } = await supabase
        .from("jobs")
        .select("id, source, chat_id, studio_id")
        .eq("status", "running")
        .or(`heartbeat_at.lt.${staleThreshold},heartbeat_at.is.null`);

      if (stuckJobs && stuckJobs.length > 0) {
        console.log(`[Watchdog] Found ${stuckJobs.length} stuck jobs. Recovering...`);
        for (const job of stuckJobs) {
          await supabase
            .from("jobs")
            .update({
              status: "error",
              error: "Worker crashed or timed out (Watchdog recovery)",
              reserved_cost: 0,
              updated_at: new Date().toISOString()
            })
            .eq("id", job.id);
            
          if (job.source === "telegram") {
             let targetChatId = job.chat_id;
             if (!targetChatId) {
                const { data: studio } = await supabase.from("studios").select("telegram_chat_id").eq("id", job.studio_id).single();
                targetChatId = studio?.telegram_chat_id;
             }
             if (targetChatId) {
               const { data: secrets } = await supabase
                 .from("studio_secrets")
                 .select("encrypted_bot_token, iv, auth_tag, key_version")
                 .eq("studio_id", job.studio_id)
                 .single();

               if (secrets?.encrypted_bot_token) {
                 const { TelegramBot } = await import("../lib/telegram/TelegramBot");
                 const bot = new TelegramBot(secrets as any);
                 await bot.sendMessage(
                   targetChatId,
                   "❌ Pipeline failed: Server crashed or timed out during the process. Please try again."
                 ).catch(e => console.error("[Watchdog] Telegram notif failed", e));
               }
             }
          }
        }
      }
    } catch (err) {
      console.error("[Watchdog] Error:", err);
    }
  }, 60 * 1000);
}

async function main(): Promise<void> {
  console.log("[Worker] Starting ECS Worker services...");

  // 1. Start outbox dispatcher
  await startOutboxDispatcher();

  // 2. Start pipeline worker
  const pipelineWorker = startPipelineWorker();

  // 3. Start Watchdog
  startWatchdog();

  // 4. Start Telegram Polling Worker
  startTelegramPollWorker();

  console.log("[Worker] All services started successfully");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[Worker] Shutting down...");
    await pipelineWorker.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
