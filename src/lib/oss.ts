import OSS from "ali-oss";
import Credential from "@alicloud/credentials";

let ossClient: OSS | null = null;

/**
 * Returns a configured Alibaba Cloud OSS client.
 * 
 * Authentication priority:
 * 1. ECS RAM Role (recommended for production — temporary credentials, no permanent keys)
 * 2. Explicit AccessKey from environment (fallback for development)
 * 
 * Uses Singapore region internal endpoint when running on ECS for zero-cost data transfer.
 */
export function getOSSClient(): OSS {
  if (ossClient) return ossClient;

  const bucket = process.env.OSS_BUCKET;
  const region = process.env.OSS_REGION || "oss-ap-southeast-1"; // Singapore

  if (!bucket) {
    throw new Error("OSS_BUCKET environment variable is required");
  }

  // Use internal endpoint on ECS (free traffic within same region)
  const internal = process.env.OSS_INTERNAL === "true";
  const endpoint = internal
    ? `${region}-internal.aliyuncs.com`
    : `${region}.aliyuncs.com`;

  // Try RAM role first (ECS Instance Metadata), fallback to explicit keys
  const accessKeyId = process.env.ALIBABA_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIBABA_ACCESS_KEY_SECRET;
  const ramRoleName = process.env.ECS_RAM_ROLE;

  if (ramRoleName) {
    // Use ECS RAM role for temporary credentials (production)
    const CredClass = (Credential as any).default || Credential;
    const credential = new CredClass({
      type: "ecs_ram_role",
      roleName: ramRoleName,
    });

    ossClient = new OSS({
      region,
      bucket,
      endpoint,
      // ali-oss accepts a refreshSTSToken callback for temporary credentials
      accessKeyId: "placeholder",
      accessKeySecret: "placeholder",
      refreshSTSToken: async () => {
        const cred = await credential.getCredential();
        return {
          accessKeyId: cred.accessKeyId,
          accessKeySecret: cred.accessKeySecret,
          stsToken: cred.securityToken,
        };
      },
      refreshSTSTokenInterval: 300000, // Refresh every 5 minutes
    });
  } else if (accessKeyId && accessKeySecret) {
    // Explicit keys (development only)
    ossClient = new OSS({
      region,
      bucket,
      endpoint,
      accessKeyId,
      accessKeySecret,
    });
  } else {
    throw new Error(
      "Either ECS_RAM_ROLE or ALIBABA_ACCESS_KEY_ID/SECRET must be configured"
    );
  }

  return ossClient;
}

/**
 * Uploads a buffer to OSS and returns the public URL.
 */
export async function uploadToOSS(
  buffer: Buffer,
  objectKey: string,
  contentType: string
): Promise<string> {
  const client = getOSSClient();
  const result = await client.put(objectKey, buffer, {
    headers: { "Content-Type": contentType },
  });
  return result.url;
}

/**
 * Uploads media from a URL to OSS (downloads first, then uploads).
 */
export async function uploadMediaFromUrl(
  sourceUrl: string,
  prefix: string,
  contentType?: string
): Promise<string> {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download media: ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = contentType?.includes("video") ? "mp4"
    : contentType?.includes("audio") ? "mp3"
    : contentType?.includes("image") ? "png"
    : "bin";
  const objectKey = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  return uploadToOSS(buffer, objectKey, contentType || "application/octet-stream");
}

/**
 * Generates a presigned URL for direct browser upload.
 * Returns { uploadUrl, objectKey, publicUrl }.
 */
export async function generatePresignedUpload(
  prefix: string,
  filename: string,
  contentType: string,
  maxSizeBytes = 10 * 1024 * 1024 // 10MB default
): Promise<{ uploadUrl: string; objectKey: string; publicUrl: string }> {
  const client = getOSSClient();
  const ext = filename.split(".").pop() || "bin";
  const objectKey = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

  // Generate presigned PUT URL (valid for 15 minutes)
  const uploadUrl = client.signatureUrl(objectKey, {
    method: "PUT",
    expires: 900,
    "Content-Type": contentType,
  });

  const bucket = process.env.OSS_BUCKET!;
  const region = process.env.OSS_REGION || "oss-ap-southeast-1";
  const publicUrl = `https://${bucket}.${region}.aliyuncs.com/${objectKey}`;

  return { uploadUrl, objectKey, publicUrl };
}
