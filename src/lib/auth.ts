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
 * Role hierarchy and access check for ECS endpoints.
 * Precedence: owner > editor collaborator > viewer collaborator > shared_link viewer
 */
export async function verifyStudioAccess(
  studioId: string,
  userId: string,
  requiredRole: 'owner' | 'editor' | 'viewer',
  userEmail?: string
): Promise<{ role: 'owner' | 'editor' | 'viewer'; accessSource: string }> {
  const supabase = getServiceSupabase();

  // 1. Check basic studio metadata
  const { data: studio, error: studioErr } = await supabase
    .from("studios")
    .select("id, user_id, sharing_visibility, share_token")
    .eq("id", studioId)
    .single();

  if (studioErr || !studio) {
    throw new AuthError("Studio not found or access denied", 403);
  }

  let resolvedRole: 'owner' | 'editor' | 'viewer' | null = null;
  let accessSource: string = '';

  // Level 1: Owner
  if (studio.user_id === userId) {
    resolvedRole = 'owner';
    accessSource = 'owner';
  } else {
    // Level 2 & 3: Permanent Collaborator
    const collabQuery = supabase
      .from("studio_collaborators")
      .select("role")
      .eq("studio_id", studioId);

    if (userEmail) {
      collabQuery.or(`user_id.eq.${userId},user_email.eq.${userEmail}`);
    } else {
      collabQuery.eq("user_id", userId);
    }

    const { data: collabs } = await collabQuery;
    if (collabs && collabs.length > 0) {
      const isEditor = collabs.some((c) => c.role === 'editor');
      resolvedRole = isEditor ? 'editor' : 'viewer';
      accessSource = 'collaborator';
    } else if (studio.sharing_visibility === 'link_view' && studio.share_token) {
      // Level 4: Ephemeral Shared Link Grant
      const { data: grant } = await supabase
        .from("studio_shared_access_grants")
        .select("granted_token_snapshot")
        .eq("studio_id", studioId)
        .eq("user_id", userId)
        .maybeSingle();

      if (grant && grant.granted_token_snapshot === studio.share_token) {
        resolvedRole = 'viewer';
        accessSource = 'shared_link';
      }
    }
  }

  if (!resolvedRole) {
    throw new AuthError("403 Forbidden Access Denied: No access to this studio", 403);
  }

  // Check role hierarchy against requiredRole
  const roleWeights: Record<'owner' | 'editor' | 'viewer', number> = {
    owner: 3,
    editor: 2,
    viewer: 1,
  };

  if (roleWeights[resolvedRole] < roleWeights[requiredRole]) {
    throw new AuthError(`403 Forbidden Access Denied: Requires ${requiredRole} or higher role (your role is ${resolvedRole})`, 403);
  }

  return { role: resolvedRole, accessSource };
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
