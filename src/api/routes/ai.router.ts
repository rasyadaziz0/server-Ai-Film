import { Router, Request, Response, NextFunction } from "express";
import { verifyJwt, verifyStudioOwnership, verifyStudioAccess, AuthError } from "../../lib/auth";

export const aiRouter = Router();

/**
 * POST /v1/ai/upload-actor/presign
 * Returns a presigned OSS upload URL for direct browser upload.
 * Browser uploads directly to OSS — no buffering in Vercel or ECS.
 */
aiRouter.post(
  "/upload-actor/presign",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await verifyJwt(req.headers.authorization);
      const { studioId, filename, contentType } = req.body;

      if (!studioId || !filename || !contentType) {
        return res.status(400).json({ error: "studioId, filename, and contentType are required" });
      }

      // Validate content type
      if (!contentType.startsWith("image/")) {
        return res.status(400).json({ error: "Only image uploads are allowed" });
      }

      await verifyStudioAccess(studioId, user.sub, 'editor', user.email);

      // Use Cloudflare R2 instead of Alibaba OSS
      const { CloudflareR2 } = await import("../../../../src/lib/cloud/CloudflareR2");
      const result = await CloudflareR2.generatePresignedUpload(
        `actor-images/${studioId}`,
        filename,
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await verifyJwt(req.headers.authorization);
      const { studioId, prompt } = req.body;

      if (!prompt) {
        return res.status(400).json({ error: "prompt is required" });
      }

      if (studioId) {
        await verifyStudioAccess(studioId, user.sub, 'editor', user.email);
      }

      const apiKey = process.env.DASHSCOPE_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "DASHSCOPE_API_KEY not configured" });
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

