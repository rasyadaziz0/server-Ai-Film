/**
 * Budget estimation utilities using integer micro-USD (1 USD = 1,000,000 micro-USD).
 * Avoids floating-point precision errors in financial calculations.
 */

/** 1 USD in micro-USD */
export const USD = 1_000_000;

/**
 * Estimated cost per 5-second Wan 2.7 video clip in micro-USD.
 * ~$0.50 per clip = 500,000 micro-USD
 */
const VIDEO_CLIP_COST = 500_000;

/**
 * Estimated overhead for text nodes (Producer, Writer, Reviewer, etc.) in micro-USD.
 * ~$0.05 = 50,000 micro-USD
 */
const TEXT_NODE_COST = 50_000;

/**
 * Estimated cost for TTS generation in micro-USD.
 * ~$0.10 = 100,000 micro-USD
 */
const TTS_COST = 100_000;

/**
 * Estimated cost for image generation in micro-USD.
 * ~$0.05 = 50,000 micro-USD
 */
const IMAGE_COST = 50_000;

/**
 * Estimates the total cost of a pipeline run in micro-USD.
 * @param videoDuration Duration in seconds (5, 15, or 30)
 * @param hasActor Whether the pipeline includes an Actor node (image gen)
 * @param hasTTS Whether the pipeline includes a TTS node
 */
export function estimatePipelineCost(
  videoDuration: number,
  hasActor = false,
  hasTTS = false
): number {
  const clipCount = Math.max(1, Math.floor(videoDuration / 5));
  const videoCost = clipCount * VIDEO_CLIP_COST;
  const textCost = 3 * TEXT_NODE_COST; // Producer + Writer + Reviewer average
  const actorCost = hasActor ? IMAGE_COST : 0;
  const ttsCost = hasTTS ? TTS_COST : 0;

  return videoCost + textCost + actorCost + ttsCost;
}

/**
 * Default daily budget limit in micro-USD ($5.00).
 */
export function getDailyLimitMicroUsd(): number {
  const env = process.env.DAILY_CREDIT_LIMIT_USD;
  if (env) {
    return Math.round(parseFloat(env) * USD);
  }
  return 5 * USD; // $5.00 default
}
