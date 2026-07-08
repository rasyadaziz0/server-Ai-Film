import { Queue } from "bullmq";
import IORedis from "ioredis";

/**
 * Shared Redis connection for BullMQ queues.
 */
export function getRedisConnection(): IORedis {
  return new IORedis(process.env.REDIS_URL || "redis://redis:6379", {
    maxRetriesPerRequest: null, // Required by BullMQ
  });
}

/**
 * Pipeline execution queue.
 * Jobs contain: { jobId, studioId, targetNodeId?, source }
 */
export const pipelineQueue = new Queue("pipeline-queue", {
  connection: getRedisConnection() as any,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
    attempts: 1, // No automatic retry — we handle retry logic at the node level
  },
});

/**
 * Video polling queue for async DashScope Wan 2.7 tasks.
 * Jobs contain: { nodeRunId, taskId, studioId, jobId, nodeId, attempt }
 */
export const videoPollQueue = new Queue("video-poll-queue", {
  connection: getRedisConnection() as any,
  defaultJobOptions: {
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
    attempts: 60, // Max 60 poll attempts (~10 minutes with backoff)
    backoff: {
      type: "exponential",
      delay: 5000, // Start at 5s, exponential backoff
    },
  },
});
