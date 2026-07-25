
/**
 * Unified Kill Switch — fail-closed.
 * If AI_GENERATION_ENABLED is not explicitly "true", all generation is blocked.
 * This matches the frontend check in requireAuth.ts for consistency.
 */
export function checkKillSwitch(): void {
  if (process.env.AI_GENERATION_ENABLED !== "true") {
    throw new KillSwitchError("AI generation is disabled. Set AI_GENERATION_ENABLED=true to enable.");
  }
}

export class KillSwitchError extends Error {
  public statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = "KillSwitchError";
  }
}
