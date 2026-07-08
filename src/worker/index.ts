import "dotenv/config";
import { startOutboxDispatcher } from "./outboxDispatcher";
import { startPipelineWorker } from "./pipelineWorker";
import { startVideoPollWorker, reconcileWaitingTasks } from "./videoPollWorker";


async function main(): Promise<void> {
  console.log("[Worker] Starting ECS Worker services...");

  // 1. Start outbox dispatcher
  await startOutboxDispatcher();

  // 2. Start pipeline worker
  const pipelineWorker = startPipelineWorker();

  // 3. Start video poll worker
  const videoPollWorker = startVideoPollWorker();

  // 4. Reconcile any orphaned tasks from previous runs
  await reconcileWaitingTasks();

  console.log("[Worker] All services started successfully");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[Worker] Shutting down...");
    await pipelineWorker.close();
    await videoPollWorker.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
