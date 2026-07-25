import { Router, Request, Response, NextFunction } from "express";
import { verifyJwt, verifyStudioOwnership, verifyStudioAccess, AuthError, requireJwt } from "../../lib/auth";
import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { rateLimitRedis } from "../../worker/queues";

export const aiRouter = Router();

// Rate limiter: 10 uploads per 15 minutes per user
const uploadRateLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args: string[]) => {
      return rateLimitRedis.call(args[0], ...args.slice(1)) as any;
    },
  }),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  keyGenerator: (req: any) => req.user?.sub || (req.ip || "unknown").replace(/:/g, "_"),
  message: { error: "Too many upload requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter: 5 image generations per 1 minute per user
const imageRateLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args: string[]) => {
      return rateLimitRedis.call(args[0], ...args.slice(1)) as any;
    },
  }),
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  keyGenerator: (req: any) => req.user?.sub || (req.ip || "unknown").replace(/:/g, "_"),
  message: { error: "Too many image generation requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /v1/ai/upload-actor/presign
 * Returns a presigned OSS upload URL for direct browser upload.
 * Browser uploads directly to OSS — no buffering in Vercel or ECS.
 */
aiRouter.post(
  "/upload-actor/presign",
  requireJwt,
  uploadRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const { studioId, contentType } = req.body;

      if (!studioId || !contentType) {
        return res.status(400).json({ error: "studioId and contentType are required" });
      }

      // Strict allowlist to prevent Stored XSS via SVG or arbitrary files
      const allowedTypes: Record<string, string> = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp"
      };

      const ext = allowedTypes[contentType];
      if (!ext) {
        return res.status(400).json({ error: "Only PNG, JPEG, and WEBP images are allowed" });
      }

      await verifyStudioAccess(studioId, user.sub, 'editor', user.email);

      // Server-generated safe filename
      const safeFilename = `${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`;

      // Use Cloudflare R2 instead of Alibaba OSS
      const { CloudflareR2 } = await import("../../../../src/lib/cloud/CloudflareR2");
      const result = await CloudflareR2.generatePresignedUpload(
        `actor-images/${studioId}`,
        safeFilename,
        contentType
      );

      return res.json({
        uploadUrl: result.uploadUrl,
        objectKey: result.objectKey,
        publicUrl: result.publicUrl,
      });
    } catch (err: any) {
      if (err instanceof AuthError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      next(err);
    }
  }
);

/**
 * POST /v1/ai/generate-image
 * Generates an actor/character image using DashScope qwen-image-plus,
 * polls until complete, and immediately uploads the result to Alibaba OSS.
 */
aiRouter.post(
  "/generate-image",
  requireJwt,
  imageRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const { studioId, prompt } = req.body;

      if (!prompt) {
        return res.status(400).json({ error: "prompt is required" });
      }

      if (!studioId) {
        return res.status(400).json({ error: "studioId is required" });
      }

      await verifyStudioAccess(studioId, user.sub, 'editor', user.email);

      const apiKey = process.env.DASHSCOPE_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "DASHSCOPE_API_KEY not configured" });
      }

      // Check budget before generating
      const { getServiceSupabase } = await import("../../lib/supabase");
      const { getDailyLimitMicroUsd } = await import("../../lib/budget");
      
      const IMAGE_COST = 50_000; // micro-USD
      const serviceSupabase = getServiceSupabase();
      
      const { data: rpcResult, error: rpcError } = await serviceSupabase.rpc("reserve_image_spend", {
        p_studio_id: studioId,
        p_user_id: user.sub,
        p_cost: IMAGE_COST,
        p_daily_limit: getDailyLimitMicroUsd()
      });

      if (rpcError) {
        console.error("[AIRouter] Budget RPC Error:", rpcError);
        return res.status(500).json({ error: "Failed to verify daily limit" });
      }

      const budgetStatus = rpcResult as any;
      if (budgetStatus.error === "daily_budget_exceeded") {
        return res.status(429).json({ error: "Daily budget exceeded for image generation" });
      }
      if (budgetStatus.error === "studio_not_found") {
        return res.status(403).json({ error: "Studio not found" });
      }

      console.log(`[AIRouter] Generating image for prompt: "${prompt.substring(0, 50)}..."`);

      const dashRes = await fetch(
        "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "qwen-image-plus",
            input: { prompt },
            parameters: { size: "1024*1024", n: 1 },
          }),
        }
      );

      const dashData: any = await dashRes.json();
      if (dashData.code && dashData.code !== "200") {
        throw new Error(dashData.message || "Image synthesis submission failed");
      }

      const taskId = dashData.output?.task_id;
      if (!taskId) {
        throw new Error("No task_id returned from DashScope");
      }

      // Poll until image generation completes (~5-10s)
      let imageUrl = "";
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const pollRes = await fetch(`https://dashscope-intl.aliyuncs.com/api/v1/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const pollData: any = await pollRes.json();
        if (pollData.output?.task_status === "SUCCEEDED") {
          imageUrl = pollData.output.results[0].url;
          break;
        }
        if (pollData.output?.task_status === "FAILED") {
          throw new Error(pollData.output?.message || "Image generation failed");
        }
      }

      if (!imageUrl) {
        throw new Error("Image generation timeout");
      }

      // Immediately download from DashScope and upload to Cloudflare R2 (prevents 24h expiration)
      const { CloudflareR2 } = await import("../../../../src/lib/cloud/CloudflareR2");
      const uploadRes = await CloudflareR2.uploadMedia(
        imageUrl,
        `actor-images/${studioId || user.sub || "default"}`
      );
      const r2Url = uploadRes.url;

      console.log(`[AIRouter] Image generated and uploaded to R2: ${r2Url}`);
      return res.json({ url: r2Url });
    } catch (err: any) {
      if (err instanceof AuthError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      next(err);
    }
  }
);

