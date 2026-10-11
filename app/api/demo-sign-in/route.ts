// POST /api/demo-sign-in with { "email": one of the three demo emails }. The one-click buttons on
// the login page. No login needed and no password involved: lib/server/demo-sign-in.ts does the work.
// Only from this site's own pages, so another site cannot sign a visitor in (login CSRF).

import { sameSite } from "@/lib/server/auth";
import { demoSignIn } from "@/lib/server/demo-sign-in";
import { HttpError } from "@/lib/server/http-error";
import { adminClient } from "@/lib/server/supabase";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request): Promise<Response> {
  try {
    if (!sameSite(request)) throw new HttpError(403, "cross_site", "This request did not come from this site.");
    let email: unknown;
    try {
      email = (JSON.parse(await request.text()) as { email?: unknown }).email;
    } catch {
      throw new HttpError(400, "bad_input", "The request body is not valid JSON.");
    }
    return Response.json(await demoSignIn(email, async () => ({ admin: adminClient(), session: await createClient() })));
  } catch (error) {
    if (error instanceof HttpError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    return Response.json({ error: "server_error", message: "The demo sign-in did not work. Try again." }, { status: 500 });
  }
}
