// The project URL and the publishable (public) key. Safe in a browser: row-level security decides
// what a logged-in user may read. The secret key is never read here (lib/server/supabase.ts has it).
//
// The NEXT_PUBLIC_ names are written out in full so Next.js can inline them into browser code.
// On the server, SUPABASE_URL wins, so the flow tests can point every client at the test project.

export function publicSupabaseConfig(): { url: string; publishableKey: string } {
  const onServer = typeof window === "undefined";
  const url = (onServer ? process.env.SUPABASE_URL : undefined) || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) throw new Error("The Supabase URL or publishable key is not set.");
  return { url, publishableKey };
}
