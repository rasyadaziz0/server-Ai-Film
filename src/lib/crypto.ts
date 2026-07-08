import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits recommended for GCM
const TAG_LENGTH = 16; // 128 bits

/**
 * Returns the encryption key for the given version.
 * Keys are stored in environment variables: ENCRYPTION_KEY_V1, ENCRYPTION_KEY_V2, etc.
 * Key must be 32 bytes (256 bits), hex-encoded (64 chars).
 */
function getKey(version: number): Buffer {
  const envKey = process.env[`ENCRYPTION_KEY_V${version}`];
  if (!envKey) {
    throw new Error(`ENCRYPTION_KEY_V${version} is not configured`);
  }
  const key = Buffer.from(envKey, "hex");
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY_V${version} must be 64 hex chars (32 bytes)`);
  }
  return key;
}

/**
 * Returns the current key version (defaults to 1).
 */
function getCurrentKeyVersion(): number {
  return parseInt(process.env.ENCRYPTION_KEY_VERSION || "1", 10);
}

/**
 * AES-256-GCM encrypt a plaintext string.
 * Returns { ciphertext, iv, auth_tag, key_version } for storage.
 */
export function encrypt(plaintext: string): {
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: number;
} {
  const version = getCurrentKeyVersion();
  const key = getKey(version);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted,
    iv: iv.toString("base64"),
    auth_tag: authTag.toString("base64"),
    key_version: version,
  };
}

/**
 * AES-256-GCM decrypt ciphertext.
 */
export function decrypt(
  ciphertext: string,
  iv: string,
  authTag: string,
  keyVersion: number
): string {
  const key = getKey(keyVersion);
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, "base64"),
    { authTagLength: TAG_LENGTH }
  );
  decipher.setAuthTag(Buffer.from(authTag, "base64"));

  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * HMAC-SHA256 hash (for webhook secrets and tokens that need verification but not decryption).
 */
export function hmacSha256(value: string): string {
  const secret = process.env.HMAC_SECRET;
  if (!secret) throw new Error("HMAC_SECRET is not configured");
  return createHmac("sha256", secret).update(value).digest("hex");
}

/**
 * Constant-time comparison of two strings.
 * Prevents timing attacks on webhook secret verification.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;

  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  if (bufA.length !== bufB.length) {
    // Still perform comparison to avoid length-based timing leak
    const dummy = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, dummy);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/**
 * Generates a cryptographically secure random string.
 */
export function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}
