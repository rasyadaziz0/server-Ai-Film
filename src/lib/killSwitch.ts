
export function checkKillSwitch(): void {
  if (process.env.KILL_SWITCH === "1" || process.env.KILL_SWITCH === "true") {
    throw new KillSwitchError("Kill switch is active. All AI generation is paused.");
  }
}

export class KillSwitchError extends Error {
  public statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = "KillSwitchError";
  }
}
