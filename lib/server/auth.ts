// Login and role checks for every server function (specs/08-security.md row 7).
//
// Three ways in, tried in this order:
//   1. A customer token in the body ("customerToken"), only on routes that allow the customer.
//      It is the signed case link of the phone mock (customer-link.ts) and reaches that one case.
//   2. A login token in the Authorization header ("Bearer <token>"), as the flow tests send it.
//   3. The login cookie the screens carry (@supabase/ssr). Only from this site's own pages: a
//      request from another site is refused, so it cannot use the visitor's cookie (CSRF).
// getClaims() checks the token's signature, as Supabase's Next.js guide recommends; getSession()
// is never trusted on the server. The role and merchant come from public.profiles, never from the
// login's own metadata, which a user can edit for themselves.

import "server-only";
import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { publicSupabaseConfig } from "@/lib/supabase/config";
import { caseIdFromToken } from "./customer-link";
import { HttpError } from "./http-error";

export type AppRole = "lender" | "insurer" | "ops";
export type CallerRole = AppRole | "customer";

export interface Caller {
  /** Empty for a customer, who has no login. */
  userId: string | null;
  role: CallerRole;
  /** Empty for ops and for a customer. */
  merchantId: string | null;
  /** The one case a customer's link reaches. */
  caseId?: string;
  /** How this caller is named in audit_log. */
  actor: string;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/** True when the request came from a page of this same site. */
export function sameSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") === "same-origin";
  try {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function userFromToken(db: SupabaseClient, token: string): Promise<string | undefined> {
  try {
    const { data, error } = await db.auth.getClaims(token);
    return error ? undefined : data?.claims?.sub;
  } catch {
    return undefined; // A token that is not a JWT at all.
  }
}

async function userFromCookie(request: Request): Promise<string | undefined> {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  if (!sameSite(request)) throw new HttpError(403, "cross_site", "This request did not come from this site.");
  try {
    const { url, publishableKey } = publicSupabaseConfig();
    const supabase = createServerClient(url, publishableKey, {
      cookies: {
        getAll: () => parseCookieHeader(header).map(({ name, value }) => ({ name, value: value ?? "" })),
        // proxy.ts refreshes the cookie; a route answer does not carry it.
        setAll: () => {},
      },
    });
    const { data, error } = await supabase.auth.getClaims();
    return error ? undefined : data?.claims?.sub;
  } catch {
    return undefined;
  }
}

/**
 * Throws 401 without a valid login, 403 when the caller's role is not in `roles`.
 * `body` is read only for a customer token, and only when `roles` includes "customer".
 */
export async function requireRole(
  request: Request,
  db: SupabaseClient,
  roles: CallerRole[],
  body: Record<string, unknown> = {},
): Promise<Caller> {
  if (roles.includes("customer") && typeof body.customerToken === "string") {
    const caseId = caseIdFromToken(body.customerToken);
    if (!caseId) throw new HttpError(401, "bad_link", "This link is not valid.");
    return { userId: null, role: "customer", merchantId: null, caseId, actor: `customer:${caseId}` };
  }

  const token = bearerToken(request);
  if (!token && !request.headers.get("cookie")) throw new HttpError(401, "not_logged_in", "Log in first.");
  const userId = token ? await userFromToken(db, token) : await userFromCookie(request);
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
