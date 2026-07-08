import { Worker, Job } from "bullmq";
import { getRedisConnection, videoPollQueue, pipelineQueue } from "./queues";
import { getServiceSupabase } from "../lib/supabase";

interface VideoPollJobData {
  nodeRunId: string;
  taskId: string;
  studioId: string;
  jobId: string;
  nodeId: string;
  attempt: number;
}

const MAX_POLL_ATTEMPTS = 60;

export function startVideoPollWorker(): Worker {
  const worker = new Worker<VideoPollJobData>(
    "video-poll-queue",
    async (job: Job<VideoPollJobData>) => {
      const { nodeRunId, taskId, studioId, jobId, nodeId, attempt } = job.data;
      console.log(`[VideoPollWorker] Polling task ${taskId} (attempt ${attempt}/${MAX_POLL_ATTEMPTS})`);

      const supabase = getServiceSupabase();

      // Check if node_run is still in waiting_external (might have been cancelled)
      const { data: nodeRun } = await supabase
        .from("node_runs")
        .select("status")
        .eq("id", nodeRunId)
        .single();

      if (!nodeRun || nodeRun.status !== "waiting_external") {
        console.log(`[VideoPollWorker] node_run ${nodeRunId} is no longer waiting (${nodeRun?.status}), skipping`);
        return;
      }

      // Poll DashScope task status
      const apiKey = process.env.DASHSCOPE_API_KEY;
      if (!apiKey) throw new Error("DASHSCOPE_API_KEY not configured");

      const res = await fetch(`https://dashscope-intl.aliyuncs.com/api/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data: any = await res.json();
      const taskStatus = data.output?.task_status;

      console.log(`[VideoPollWorker] Task ${taskId} status: ${taskStatus}`);

      if (taskStatus === "SUCCEEDED") {
        // Update node_run to processing_media
        await supabase
          .from("node_runs")
          .update({ status: "processing_media", updated_at: new Date().toISOString() })
          .eq("id", nodeRunId);

        const videoUrl = data.output?.video_url;
        if (!videoUrl) {
          await supabase
            .from("node_runs")
            .update({ status: "failed", error: "No video URL in response", updated_at: new Date().toISOString() })
            .eq("id", nodeRunId);
          return;
        }

        // Download and upload to Cloudflare R2
        try {
          const { CloudflareR2 } = await import("../../../src/lib/cloud/CloudflareR2");
          const uploadRes = await CloudflareR2.uploadMedia(videoUrl, `video/${studioId}`);
          const r2Url = uploadRes.url;

          // Update node_run as succeeded
          await supabase
            .from("node_runs")
            .update({
              status: "succeeded",
              output_url: r2Url,
              updated_at: new Date().toISOString(),
            })
            .eq("id", nodeRunId);

          // Update the workflow node with the result
          await supabase
            .from("nodes")
            .update({ output_url: r2Url, status: "done" })
            .eq("id", nodeId)
            .eq("studio_id", studioId);

          // Resume pipeline execution for downstream nodes
          await pipelineQueue.add(
            "run-pipeline",
            { jobId, studioId, source: "video-poll-resume" },
            { jobId: `${jobId}-resume-${Date.now()}` }
          );

          console.log(`[VideoPollWorker] Task ${taskId} completed! R2 URL: ${r2Url}`);
        } catch (uploadErr: any) {
          console.error(`[VideoPollWorker] Upload failed for task ${taskId}:`, uploadErr.message);
          await supabase
            .from("node_runs")
            .update({ status: "failed", error: uploadErr.message, updated_at: new Date().toISOString() })
            .eq("id", nodeRunId);

          await supabase
            .from("nodes")
            .update({ status: "error" })
            .eq("id", nodeId)
            .eq("studio_id", studioId);
        }

        return;
      }

      if (taskStatus === "FAILED") {
        const errMsg = data.output?.message || "Video generation failed";
        await supabase
          .from("node_runs")
          .update({ status: "failed", error: errMsg, updated_at: new Date().toISOString() })
          .eq("id", nodeRunId);

        await supabase
          .from("nodes")
          .update({ status: "error" })
          .eq("id", nodeId)
          .eq("studio_id", studioId);

        console.error(`[VideoPollWorker] Task ${taskId} FAILED: ${errMsg}`);
        return;
      }

      // Still running — re-enqueue with backoff + jitter
      if (attempt >= MAX_POLL_ATTEMPTS) {
        await supabase
          .from("node_runs")
          .update({ status: "failed", error: "Polling timeout", updated_at: new Date().toISOString() })
          .eq("id", nodeRunId);

        await supabase
          .from("nodes")
          .update({ status: "error" })
          .eq("id", nodeId)
          .eq("studio_id", studioId);

        console.error(`[VideoPollWorker] Task ${taskId} timed out after ${MAX_POLL_ATTEMPTS} attempts`);
        return;
      }

      // Exponential backoff: 5s, 10s, 15s, 20s... capped at 30s, plus jitter
      const baseDelay = Math.min(5000 * (attempt + 1), 30000);
      const jitter = Math.random() * 3000;
      const delay = Math.round(baseDelay + jitter);

      await videoPollQueue.add(
        "poll-video",
        { ...job.data, attempt: attempt + 1 },
        { delay, jobId: `${nodeRunId}-poll-${attempt + 1}` }
      );

      console.log(`[VideoPollWorker] Re-enqueued task ${taskId} with ${delay}ms delay (attempt ${attempt + 1})`);
    },
    {
      connection: getRedisConnection() as any,
      concurrency: 5, // Can poll multiple tasks in parallel
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[VideoPollWorker] Job ${job?.id} failed:`, err.message);
  });

  console.log("[VideoPollWorker] Started");
  return worker;
}

/**
 * Startup reconciliation: re-enqueue all node_runs in waiting_external state.
 * Called when worker starts or restarts to resume orphaned polling tasks.
 */
export async function reconcileWaitingTasks(): Promise<void> {
  console.log("[VideoPollWorker] Running startup reconciliation...");

  const supabase = getServiceSupabase();

  const { data: waitingRuns, error } = await supabase
    .from("node_runs")
    .select("id, provider_task_id, studio_id, job_id, node_id")
    .eq("status", "waiting_external")
    .not("provider_task_id", "is", null);

  if (error) {
    console.error("[VideoPollWorker] Reconciliation query failed:", error);
    return;
  }

  if (!waitingRuns || waitingRuns.length === 0) {
    console.log("[VideoPollWorker] No orphaned tasks to reconcile");
    return;
  }

  console.log(`[VideoPollWorker] Reconciling ${waitingRuns.length} orphaned tasks`);

  for (const run of waitingRuns) {
    try {
      await videoPollQueue.add(
        "poll-video",
        {
          nodeRunId: run.id,
          taskId: run.provider_task_id,
          studioId: run.studio_id,
          jobId: run.job_id,
          nodeId: run.node_id,
          attempt: 0, // Restart polling from attempt 0
        },
        { jobId: `${run.id}-reconcile` }
      );
      console.log(`[VideoPollWorker] Reconciled task ${run.provider_task_id} for node_run ${run.id}`);
    } catch (e: any) {
      if (e.message?.includes("already exists")) {
        console.log(`[VideoPollWorker] Task ${run.provider_task_id} already in queue, skipping`);
      } else {
        console.error(`[VideoPollWorker] Failed to reconcile ${run.id}:`, e.message);
      }
    }
  }
}
