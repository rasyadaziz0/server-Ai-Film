import { Worker, Job } from "bullmq";
import { getRedisConnection } from "./queues";
import { getServiceSupabase } from "../lib/supabase";

interface PipelineJobData {
  jobId: string;
  studioId: string;
  targetNodeId?: string;
  source: string;
}

/**
 * Pipeline Worker
 * 
 * Consumes pipeline-queue jobs and executes the AI agent pipeline.
 * Uses ServerEngine for actual node execution.
 * Updates heartbeat_at for watchdog monitoring.
 */
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
          const engine = new ServerEngine(studioId, jobId);

          if (targetNodeId) {
            console.log(`[PipelineWorker] Single node execution: ${targetNodeId}`);
            await engine.runSingleNode(targetNodeId);
          } else {
            console.log(`[PipelineWorker] Running full pipeline for studio ${studioId}`);
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
    },
    {
      connection: getRedisConnection() as any,
      concurrency: 1, // Process one pipeline at a time (FFmpeg constraint)
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[PipelineWorker] Job ${job?.id} failed:`, err.message);
  });

  console.log("[PipelineWorker] Started");
  return worker;
}
