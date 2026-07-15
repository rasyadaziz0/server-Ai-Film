import { Router, Request, Response, NextFunction } from "express";
import { verifyJwt, verifyStudioOwnership, verifyStudioAccess, verifyNodeOwnership, AuthError } from "../../lib/auth";
import { checkKillSwitch, KillSwitchError } from "../../lib/killSwitch";
import { getServiceSupabase } from "../../lib/supabase";
import { estimatePipelineCost, getDailyLimitMicroUsd } from "../../lib/budget";

export const jobsRouter = Router();

/**
 * POST /v1/jobs
 * Creates a pipeline job with atomic budget reservation.
 * Returns 202 Accepted immediately; worker picks up from outbox.
 */
jobsRouter.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Kill switch (fail-closed)
    checkKillSwitch();

    // 2. Auth — verify JWT
    const user = await verifyJwt(req.headers.authorization);

    const { studioId, idempotencyKey, targetNodeId } = req.body;

    if (!studioId) {
      return res.status(400).json({ error: "studioId is required" });
    }
    if (!idempotencyKey) {
      return res.status(400).json({ error: "idempotencyKey is required" });
    }

    // 3. Explicit access check (service-role bypasses RLS! Requires at least editor or owner role)
    await verifyStudioAccess(studioId, user.sub, 'editor', user.email);

    // 4. Validate targetNodeId if provided (untrusted browser input)
    if (targetNodeId) {
      await verifyNodeOwnership(targetNodeId, studioId);
    }

    // 5. Estimate cost and get studio info for estimation
    const supabase = getServiceSupabase();
    const { data: studio } = await supabase
      .from("studios")
      .select("video_duration")
      .eq("id", studioId)
      .single();

    // Check if studio has TTS and Actor nodes for better cost estimation
    const { data: nodeTypes } = await supabase
      .from("nodes")
      .select("type")
      .eq("studio_id", studioId);

    const types = new Set((nodeTypes || []).map((n: any) => n.type));
    const estimatedCost = estimatePipelineCost(
      studio?.video_duration || 5,
      types.has("actor"),
      types.has("tts")
    );

    // 6. Atomic RPC: create job + reserve budget + insert outbox
    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      "create_job_and_reserve",
      {
        p_studio_id: studioId,
        p_user_id: user.sub,
        p_source: "web",
        p_idempotency_key: idempotencyKey,
        p_target_node_id: targetNodeId || null,
        p_estimated_cost: estimatedCost,
        p_daily_limit: getDailyLimitMicroUsd(),
      }
    );

    if (rpcError) {
      console.error("[Jobs API] RPC error:", rpcError);
      return res.status(500).json({ error: "Failed to create job" });
    }

    const result = rpcResult as any;

    // Handle RPC result statuses
    if (result.error === "studio_not_found") {
      return res.status(403).json({ error: "Studio not found or unauthorized" });
    }
    if (result.duplicate) {
      return res.status(200).json({ success: true, jobId: result.job_id, duplicate: true });
    }
    if (result.error === "active_job_exists") {
      return res.status(409).json({ error: "Studio sudah punya job aktif. Tunggu sampai selesai." });
    }
    if (result.error === "daily_budget_exceeded") {
      return res.status(429).json({
        error: "Daily budget exceeded",
        details: {
          dailySpend: result.daily_spend,
          activeReserved: result.active_reserved,
          estimated: result.estimated,
          limit: result.limit,
        },
      });
    }

    // 7. Success — job created, outbox entry ready for dispatcher
    return res.status(202).json({ success: true, jobId: result.job_id });
  } catch (err: any) {
    if (err instanceof AuthError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    if (err instanceof KillSwitchError) {
      return res.status(503).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * POST /v1/jobs/reset
 * Resets stuck pipeline states for a studio.
 */
jobsRouter.post("/reset", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await verifyJwt(req.headers.authorization);
    const { studioId } = req.body;

    if (!studioId) {
      return res.status(400).json({ error: "studioId is required" });
    }

    await verifyStudioOwnership(studioId, user.sub);

    const supabase = getServiceSupabase();

    // Reset stuck jobs
    await supabase
      .from("jobs")
      .update({ status: "error", error: "Reset by user", reserved_cost: 0, updated_at: new Date().toISOString() })
      .eq("studio_id", studioId)
      .in("status", ["pending", "running", "polling"]);

    // Reset stuck nodes
    await supabase
      .from("nodes")
      .update({ status: "idle" })
      .eq("studio_id", studioId)
      .in("status", ["running", "queued"]);

    // Reset stuck node_runs
    await supabase
      .from("node_runs")
      .update({ status: "failed", error: "Reset by user", updated_at: new Date().toISOString() })
      .eq("studio_id", studioId)
      .in("status", ["queued", "running", "waiting_external", "processing_media"]);

    return res.json({ success: true });
  } catch (err: any) {
    if (err instanceof AuthError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
});
