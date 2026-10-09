// Keeps the login cookie fresh on every request (Supabase's Next.js guide, "Hook up proxy").
// getClaims() checks the token's signature and refreshes it when it is close to expiring.
// Pages and server functions check the login and the role again for themselves: this is only the
// first, optimistic check that sends a logged-out visitor to the login page.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicSupabaseConfig } from "./config";

/** Paths anyone may open: the login page, the engine preview and the customer phone mock. */
function isPublic(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/preview") || pathname.startsWith("/c/") || pathname.startsWith("/api/");
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  const { url, publishableKey } = publicSupabaseConfig();

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options));
        Object.entries(headers).forEach(([key, value]) => supabaseResponse.headers.set(key, value));
      },
    },
  });

  // Nothing may run between createServerClient and getClaims (Supabase's guide).
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims && !isPublic(request.nextUrl.pathname)) {
    const login = request.nextUrl.clone();
    login.pathname = "/";
    login.search = "";
    const redirect = NextResponse.redirect(login);
    for (const cookie of supabaseResponse.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }
  return supabaseResponse;
}
