"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await createClient().auth.signOut();
        router.replace("/");
        router.refresh();
        // Next.js keeps this button's state for the next sign-in in the same tab, so never leave it busy.
        setBusy(false);
      }}
      className="rounded-lg border border-white/30 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/10"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
