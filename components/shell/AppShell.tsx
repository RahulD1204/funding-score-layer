// The frame every signed-in screen shares, in the preview's look: a navy header with the
// simulated date and the sections, the page, and the "advice only" footer.
//
// The header reads the login, so it streams in behind a Suspense boundary (Cache Components);
// the fallback is the same bar without the personal parts.

import { Suspense, type ReactNode } from "react";
import { formatDate } from "@/lib/engine";
import { demoToday } from "@/lib/data/merchant";
import { getViewer, type Viewer } from "@/lib/data/session";
import NavLinks, { type NavItem } from "./NavLinks";
import SignOutButton from "./SignOutButton";

const NAV: Record<Viewer["role"], NavItem[]> = {
  lender: [
    { href: "/lender", label: "Collections queue" },
    { href: "/desk", label: "Exceptions desk" },
    { href: "/settings", label: "Settings" },
  ],
  insurer: [
    { href: "/insurer", label: "Renewals" },
    { href: "/desk", label: "Exceptions desk" },
    { href: "/settings", label: "Settings" },
  ],
  ops: [
    { href: "/ops", label: "Console" },
    { href: "/ops/audit", label: "Audit log and model card" },
    { href: "/preview", label: "Engine preview" },
  ],
};

const WHO: Record<Viewer["role"], string> = {
  lender: "Collections",
  insurer: "Renewals",
  ops: "Razorpay ops, internal console",
};

function Title() {
  return (
    <div>
      <p className="text-lg font-semibold">Funding Score Layer</p>
      <p className="text-sm text-white/70">Prototype on synthetic data. Not an official Razorpay product.</p>
    </div>
  );
}

async function HeaderBody() {
  const viewer = await getViewer();
  if (!viewer) {
    return (
      <div className="mx-auto flex w-full max-w-7xl px-4 py-3">
        <Title />
      </div>
    );
  }
  const today = await demoToday();
  return (
    <>
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Title />
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-right text-sm">
            <p className="font-medium">{viewer.merchantName ?? "Razorpay ops"}</p>
            <p className="text-white/70">{WHO[viewer.role]}</p>
          </div>
          <div className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">
            <span className="text-white/70">Simulated date </span>
            <span className="font-semibold">
              {formatDate(today)} {today.slice(0, 4)}
            </span>
          </div>
          <SignOutButton />
        </div>
      </div>
      <NavLinks items={NAV[viewer.role]} />
    </>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-navy text-white">
        <Suspense
          fallback={
            <div className="mx-auto flex w-full max-w-7xl px-4 py-3 pb-12">
              <Title />
            </div>
          }
        >
          <HeaderBody />
        </Suspense>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4">{children}</main>
      <Footer />
    </div>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line bg-white">
      <p className="mx-auto w-full max-w-7xl px-4 py-3 text-xs text-muted">
        Advice only. The layer never moves money: it suggests when to retry, and the merchant decides. Any failed check
        falls back to Razorpay&apos;s original retries. Merchants are never shown a score, a percentage or anything about
        a customer&apos;s income. Every customer and payment here is invented.
      </p>
    </footer>
  );
}

export function PageLoading({ label = "Loading…" }: { label?: string }) {
  return <p className="rounded-lg border border-line bg-white px-3 py-6 text-center text-sm text-muted">{label}</p>;
}
