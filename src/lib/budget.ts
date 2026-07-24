export const USD = 1_000_000;

const VIDEO_CLIP_COST = 500_000;

const TEXT_NODE_COST = 50_000;

const TTS_COST = 100_000;

const IMAGE_COST = 50_000;

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
