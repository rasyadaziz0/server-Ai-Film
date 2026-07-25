import { Worker, Job } from "bullmq";
import { getRedisConnection } from "./queues";
import { getServiceSupabase } from "../lib/supabase";

interface PipelineJobData {
  jobId: string;
  studioId: string;
  targetNodeId?: string;
  source: string;
}

export function startPipelineWorker(): Worker {
  const worker = new Worker<PipelineJobData>(
    "pipeline-queue",
    async (job: Job<PipelineJobData>) => {
      const { jobId, studioId, targetNodeId, source } = job.data;
      console.log(`[PipelineWorker] Processing job ${jobId} for studio ${studioId} (source: ${source})`);

      const supabase = getServiceSupabase();

      try {
        // Update job status to running
        await supabase
          .from("jobs")
          .update({ status: "running", heartbeat_at: new Date().toISOString() })
          .eq("id", jobId);

        // Start heartbeat interval
        const heartbeatInterval = setInterval(async () => {
          try {
            await supabase
              .from("jobs")
              .update({ heartbeat_at: new Date().toISOString() })
              .eq("id", jobId);
          } catch (e) {
            // Heartbeat failure is not fatal
          }
        }, 30000); // Every 30 seconds

        try {
          // Import and run the shared ServerEngine
          const { ServerEngine } = await import("../../../src/lib/engine/ServerEngine");
          const isResume = source === "video-poll-resume";
          const engine = new ServerEngine(studioId, jobId, undefined, isResume);

          if (targetNodeId) {
            console.log(`[PipelineWorker] Single node execution: ${targetNodeId}`);
            await engine.runSingleNode(targetNodeId);
          } else {
            console.log(`[PipelineWorker] Running ${isResume ? "RESUMED" : "full"} pipeline for studio ${studioId}`);
            await engine.runPipeline();
          }

          console.log(`[PipelineWorker] Job ${jobId} execution finished`);
        } finally {
          clearInterval(heartbeatInterval);
        }
      } catch (error: any) {
        console.error(`[PipelineWorker] Job ${jobId} failed:`, error.message);

        // Release reservation on failure
        await supabase
          .from("jobs")
          .update({
            status: "error",
            error: error.message,
            reserved_cost: 0,
            updated_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      }

      // --- Post-execution: Auto-send Telegram Notification ---
      const { data: jobInfo } = await supabase
        .from("jobs")
        .select("source, chat_id, status, result_url, error")
        .eq("id", jobId)
        .single();

      if (jobInfo?.source === "telegram") {
        // Fallback chat_id to studio config if job missing it
        let targetChatId = jobInfo.chat_id;
        if (!targetChatId) {
          const { data: studio } = await supabase.from("studios").select("telegram_chat_id").eq("id", studioId).single();
          targetChatId = studio?.telegram_chat_id;
        }

        if (targetChatId) {
          // Guard: don't double-send if a telegram node is already in the canvas
          const { count } = await supabase
            .from("nodes")
            .select("*", { count: "exact", head: true })
            .eq("studio_id", studioId)
            .eq("type", "telegram");

          if (count === 0 || jobInfo.status === "error") {
            try {
              const { data: secrets } = await supabase
                .from("studio_secrets")
                .select("encrypted_bot_token, iv, auth_tag, key_version")
                .eq("studio_id", studioId)
                .single();

              if (secrets?.encrypted_bot_token) {
                const { TelegramBot } = await import("../lib/telegram/TelegramBot");
                const bot = new TelegramBot(secrets as any);

                if (jobInfo.status === "done" && jobInfo.result_url && count === 0) {
                  console.log(`[PipelineWorker] Auto-sending video to Telegram for job ${jobId}`);
                  // Note: URL send works up to 20MB in Telegram
                  await bot.sendMediaByUrl(targetChatId, "sendVideo", jobInfo.result_url, "🎥 AI Film Studio — Pipeline Selesai!\n\nVideo Anda sudah jadi.");
                } else if (jobInfo.status === "error") {
                  console.log(`[PipelineWorker] Auto-sending error to Telegram for job ${jobId}`);
                  await bot.sendMessage(targetChatId, `❌ Pipeline gagal:\n\n${jobInfo.error || "Unknown error"}`);
                }
              }
            } catch (notifyErr: any) {
              console.error(`[PipelineWorker] Failed to send auto-notification:`, notifyErr.message);
            }
          }
        }
      }
    },
    {
      connection: getRedisConnection() as any,
      concurrency: 3, // Safe limit for FFmpeg overhead on VPS without OOM/starvation
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[PipelineWorker] Job ${job?.id} failed:`, err.message);
  });

  console.log("[PipelineWorker] Started");
  return worker;
}
