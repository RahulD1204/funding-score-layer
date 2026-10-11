// One-click demo sign-in (specs/02 screen 1, specs/08 row 21). Signs in one of the three seeded demo
// users without any password: the server asks Supabase's admin API for a one-time sign-in token
// (no email is sent) and redeems it at once, which sets the login cookie. Only the three demo
// emails are allowed; anything else is refused before Supabase is called.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ACCOUNTS, HOME } from "@/lib/view/home";
import { HttpError } from "./http-error";

export interface DemoSignInClients {
  /** Holds the secret key and creates the token. */
  admin: SupabaseClient;
  /** The cookie-backed client: the token it redeems becomes the visitor's login. */
  session: SupabaseClient;
}

/**
 * Returns the role's home screen. The clients are made only after the email passes, so a refused
 * request never reaches Supabase.
 */
export async function demoSignIn(email: unknown, clients: () => Promise<DemoSignInClients>): Promise<{ home: string }> {
  const account = DEMO_ACCOUNTS.find((a) => a.email === email);
  if (!account) throw new HttpError(403, "not_a_demo_account", "Only the three demo accounts can sign in this way.");
  const { admin, session } = await clients();

  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) throw new HttpError(502, "sign_in_failed", "The demo sign-in did not work. Try again.");

  const verified = await session.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  const userId = verified.data?.user?.id;
  if (verified.error || !userId) throw new HttpError(502, "sign_in_failed", "The demo sign-in did not work. Try again.");

  // The role comes from the profile row, never from the login, and must be the account's own.
  const { data: profile } = await admin.from("profiles").select("role").eq("user_id", userId).maybeSingle();
  if (profile?.role !== account.role) {
    await session.auth.signOut();
    throw new HttpError(403, "no_demo_role", "This demo account has no role. Run the seed again.");
  }
  return { home: HOME[account.role] };
}
