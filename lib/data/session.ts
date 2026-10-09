// Who is looking at a page. The Data Access Layer pattern from the Next.js login guide: one place
// that reads the login, verifies it and returns a narrow viewer.
//
// getClaims() verifies the login token's signature (Supabase's guide). The role and merchant come
// from public.profiles, read with the user's own login, so row-level security returns only their row.

import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { AppRole } from "@/lib/server/auth";
import { createClient } from "@/lib/supabase/server";
import { HOME } from "@/lib/view/home";

export interface Viewer {
  userId: string;
  email: string | null;
  role: AppRole;
  merchantId: string | null;
  merchantName: string | null;
}

export { HOME };

/** The signed-in viewer, or null. Read once per request. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, merchant_id, merchants(name)")
    .eq("user_id", claims.sub)
    .maybeSingle();
  if (!profile) return null;
  const merchant = profile.merchants as unknown as { name: string } | null;
  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    role: profile.role as AppRole,
    merchantId: profile.merchant_id,
    merchantName: merchant?.name ?? null,
  };
});

/** Sends a visitor without a login to the login page, and a wrong role to its own home. */
export async function requireViewer(roles: AppRole[]): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!roles.includes(viewer.role)) redirect(HOME[viewer.role]);
  return viewer;
}
