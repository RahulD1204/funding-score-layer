// Login and role checks for every server function (specs/08-security.md row 7).
//
// The browser sends the user's login token in the Authorization header ("Bearer <token>").
// getClaims() checks the token's signature, as Supabase's Next.js guide recommends; getSession()
// is never trusted on the server. The role and merchant come from public.profiles, never from the
// login's own metadata, which a user can edit for themselves.
// Cookie logins for the screens are added with the login page (build step 7).

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./http-error";

export type AppRole = "lender" | "insurer" | "ops";

export interface Caller {
  userId: string;
  role: AppRole;
  /** Empty for ops. */
  merchantId: string | null;
  /** How this caller is named in audit_log. */
  actor: string;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/** Throws 401 without a valid login, 403 when the caller's role is not in `roles`. */
export async function requireRole(request: Request, db: SupabaseClient, roles: AppRole[]): Promise<Caller> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "not_logged_in", "Log in first.");

  let userId: string | undefined;
  try {
    const { data, error } = await db.auth.getClaims(token);
    userId = error ? undefined : data?.claims?.sub;
  } catch {
    // A token that is not a JWT at all.
  }
  if (!userId) throw new HttpError(401, "bad_login", "The login is not valid. Log in again.");

  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("role, merchant_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) throw new HttpError(403, "no_profile", "This login has no role.", { userId });

  const role = profile.role as AppRole;
  const caller: Caller = { userId, role, merchantId: profile.merchant_id, actor: `${role}:${userId}` };
  if (!roles.includes(role)) throw new HttpError(403, "role_not_allowed", "Your role cannot do this.", { caller });
  return caller;
}
