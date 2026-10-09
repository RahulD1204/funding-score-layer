// The Supabase client for code that runs in the browser: the login form and sign out.
// Screens never write tables with it; every change goes through a server function in app/api/.

import { createBrowserClient } from "@supabase/ssr";
import { publicSupabaseConfig } from "./config";

export function createClient() {
  const { url, publishableKey } = publicSupabaseConfig();
  return createBrowserClient(url, publishableKey);
}
