import { getServiceSupabase } from "../lib/supabase";
import { pipelineQueue } from "./queues";

/**
 * Outbox Dispatcher
 * 
 * Polls the queue_outbox table for pending entries and enqueues them
 * into BullMQ using jobId = jobs.id (prevents duplicate enqueues).
 * 
 * This is the bridge between the atomic DB transaction and Redis.
 * If Redis was down during job creation, the outbox ensures no jobs are lost.
 */

let isRunning = false;
let isTickActive = false;

export async function startOutboxDispatcher(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  console.log("[OutboxDispatcher] Started — polling for pending entries");

  const pollInterval = parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || "1000", 10);

  const tick = async () => {
    if (!isRunning || isTickActive) return;
    isTickActive = true;

    try {
      const supabase = getServiceSupabase();

      // Fetch pending outbox entries (oldest first, batch of 10)
      const { data: entries, error } = await supabase
        .from("queue_outbox")
        .select("id, job_id, queue_name, payload, attempts")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(10);

      if (error) {
        console.error("[OutboxDispatcher] Query error:", error);
        return;
      }

      if (!entries || entries.length === 0) return;

      for (const entry of entries) {
        try {
          // Enqueue to BullMQ with jobId = job_id (idempotent)
          await pipelineQueue.add(
            "run-pipeline",
            entry.payload,
            { jobId: entry.job_id } // BullMQ will skip if jobId already exists
          );

          // Mark as enqueued
          await supabase
            .from("queue_outbox")
            .update({ status: "enqueued", updated_at: new Date().toISOString() })
            .eq("id", entry.id);

          console.log(`[OutboxDispatcher] Enqueued job ${entry.job_id}`);
        } catch (enqueueErr: any) {
          // If BullMQ already has this jobId, mark as enqueued anyway
          if (enqueueErr.message?.includes("already exists")) {
            await supabase
              .from("queue_outbox")
              .update({ status: "enqueued", updated_at: new Date().toISOString() })
              .eq("id", entry.id);
            console.log(`[OutboxDispatcher] Job ${entry.job_id} already in queue, marking enqueued`);
          } else {
            // Increment attempt counter
            await supabase
              .from("queue_outbox")
              .update({
                attempts: (entry.attempts || 0) + 1,
                status: (entry.attempts || 0) >= 5 ? "failed" : "pending",
                updated_at: new Date().toISOString(),
              })
              .eq("id", entry.id);
            console.error(`[OutboxDispatcher] Failed to enqueue job ${entry.job_id}:`, enqueueErr.message);
          }
        }
      }
    } catch (err: any) {
      console.error("[OutboxDispatcher] Tick error:", err.message);
    } finally {
      isTickActive = false;
    }
  };

  // Start polling loop
  const loop = setInterval(tick, pollInterval);

  // Run immediately on start
  await tick();

  // Cleanup on process exit
  process.on("SIGTERM", () => {
    isRunning = false;
    clearInterval(loop);
    console.log("[OutboxDispatcher] Stopped");
  });
}

export function stopOutboxDispatcher(): void {
  isRunning = false;
}
