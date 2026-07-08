import { getServiceSupabase } from "./supabase";

/**
 * JWT payload structure from Supabase Auth.
 */
export interface JwtPayload {
  sub: string; // user_id
  email?: string;
  role?: string;
  exp: number;
  iat: number;
}

/**
 * Verifies a Supabase JWT and returns the authenticated user.
 * Uses Supabase's built-in auth.getUser() for cryptographic verification.
 */
export async function verifyJwt(authHeader: string | undefined): Promise<JwtPayload> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError("Missing or invalid Authorization header", 401);
  }

  const token = authHeader.replace("Bearer ", "");
  const supabase = getServiceSupabase();

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    throw new AuthError("Invalid or expired JWT", 401);
  }

  return {
    sub: data.user.id,
    email: data.user.email,
    role: data.user.role,
    exp: 0,
    iat: 0,
  };
}

/**
 * Explicit ownership check: verifies a studio belongs to the given user.
 * Service-role bypasses RLS, so this MUST be called on every request.
 */
export async function verifyStudioOwnership(studioId: string, userId: string): Promise<void> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from("studios")
    .select("id")
    .eq("id", studioId)
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new AuthError("Studio not found or unauthorized", 403);
  }
}

/**
 * Validates that a node belongs to a specific studio.
 * Prevents IDOR when targetNodeId comes from browser.
 */
export async function verifyNodeOwnership(nodeId: string, studioId: string): Promise<void> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from("nodes")
    .select("id")
    .eq("id", nodeId)
    .eq("studio_id", studioId)
    .single();

  if (error || !data) {
    throw new AuthError("Node not found in this studio", 404);
  }
}

/**
 * Custom error class for authentication/authorization failures.
 */
export class AuthError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "AuthError";
  }
}
