// The Supabase client the server functions use. Server code only: it holds the secret key,
// which bypasses row-level security, so it must never reach a browser.
//
// The names are the ones the Vercel Marketplace integration adds. The flow tests point them at the
// test project. Values are read on every call and never printed.

import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function firstSet(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function supabaseConfig(): { url: string; secretKey: string } {
  const url = firstSet(["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]);
  const secretKey = firstSet(["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
  if (!url || !secretKey) throw new Error("The Supabase URL or secret key is not set on the server.");
  return { url, secretKey };
}

/** A fresh client for one request. It keeps no session of its own. */
export function adminClient(): SupabaseClient {
  const { url, secretKey } = supabaseConfig();
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
