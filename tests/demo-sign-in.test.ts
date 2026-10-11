// One-click demo sign-in (specs/08 row 21): only the three seeded demo emails, only from this site,
// and a refused request never reaches Supabase. Supabase is faked here; no network.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { POST } from "@/app/api/demo-sign-in/route";
import { demoSignIn } from "@/lib/server/demo-sign-in";
import { DEMO_ACCOUNTS } from "@/lib/view/home";

const SITE = "http://localhost:3000";

function call(body: unknown, origin = SITE) {
  return POST(
    new Request(`${SITE}/api/demo-sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function fakes(role: string) {
  const generateLink = vi.fn(async () => ({ data: { properties: { hashed_token: "hash-1" } }, error: null }));
  const verifyOtp = vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null }));
  const signOut = vi.fn(async () => ({ error: null }));
  const admin = {
    auth: { admin: { generateLink } },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role }, error: null }) }) }) }),
  } as unknown as SupabaseClient;
  const session = { auth: { verifyOtp, signOut } } as unknown as SupabaseClient;
  return { admin, session, generateLink, verifyOtp, signOut };
}

describe("the demo sign-in route refuses anything but the three demo emails", () => {
  it.each([
    ["another email", { email: "someone@else.example" }],
    ["a demo email in other case", { email: "LENDER@northfield.example" }],
    ["a demo email with spaces", { email: " ops@fsl.example " }],
    ["a list instead of an email", { email: ["ops@fsl.example"] }],
    ["no email", {}],
  ])("%s", async (_, body) => {
    const res = await call(body);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_a_demo_account" });
  });

  it("refuses a request from another site, and a body that is not JSON", async () => {
    expect((await call({ email: "ops@fsl.example" }, "https://evil.example")).status).toBe(403);
    expect((await call("not json")).status).toBe(400);
  });

  it("never reaches Supabase for a refused email", async () => {
    const clients = vi.fn();
    await expect(demoSignIn("someone@else.example", clients)).rejects.toMatchObject({ status: 403 });
    expect(clients).not.toHaveBeenCalled();
  });
});

describe("a demo email signs in that user and lands on its role's home screen", () => {
  it.each(DEMO_ACCOUNTS.map((a) => [a.email, a.role] as const))("%s", async (email, role) => {
    const f = fakes(role);
    const result = await demoSignIn(email, async () => f);
    expect(result).toEqual({ home: `/${role}` });
    expect(f.generateLink).toHaveBeenCalledWith({ type: "magiclink", email });
    expect(f.verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: "hash-1" });
  });

  it("signs out again if the profile's role is not the account's own", async () => {
    const f = fakes("ops");
    await expect(demoSignIn("lender@northfield.example", async () => f)).rejects.toMatchObject({ status: 403, code: "no_demo_role" });
    expect(f.signOut).toHaveBeenCalled();
  });
});
