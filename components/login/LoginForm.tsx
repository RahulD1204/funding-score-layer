"use client";

// Email sign-in (specs/02 screen 1). Supabase's login service checks the password and sets the
// login cookie; the role comes from the user's own profile row, never from the login itself.

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";
import { HOME, type HomeRole } from "@/lib/view/home";

const DEMO_ACCOUNTS = [
  { email: "lender@northfield.example", who: "Lender: Northfield Finance, collections" },
  { email: "insurer@harbour.example", who: "Insurer: Harbour Life, renewals" },
  { email: "ops@fsl.example", who: "Razorpay ops: internal console" },
];

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState(DEMO_ACCOUNTS[0].email);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (signInError || !data.user) {
      setBusy(false);
      setError("That email and password do not match a demo account.");
      return;
    }
    const { data: profile } = await supabase.from("profiles").select("role").eq("user_id", data.user.id).maybeSingle();
    const role = profile?.role as HomeRole | undefined;
    if (!role || !(role in HOME)) {
      await supabase.auth.signOut();
      setBusy(false);
      setError("This login has no role in the demo.");
      return;
    }
    router.replace(HOME[role]);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Demo account</legend>
        {DEMO_ACCOUNTS.map((a) => (
          <label key={a.email} className="flex cursor-pointer items-start gap-2 rounded-lg border border-line px-3 py-2 text-sm has-[:checked]:border-action has-[:checked]:bg-info-soft/40">
            <input
              type="radio"
              name="account"
              className="mt-1"
              checked={email === a.email}
              onChange={() => setEmail(a.email)}
            />
            <span>
              <span className="block font-medium">{a.who}</span>
              <span className="block text-muted">{a.email}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Email</span>
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-lg border border-line bg-white px-3 py-2"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg border border-line bg-white px-3 py-2"
          required
        />
      </label>
      {error && (
        <p role="alert" className="rounded-lg border border-failed/30 bg-failed-soft px-3 py-2 text-sm text-failed">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
