// Home page: the login (specs/02 screen 1). A visitor who is already signed in goes to their role's home.

import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import LoginForm from "@/components/login/LoginForm";
import { Footer, PageLoading } from "@/components/shell/AppShell";
import { HOME, getViewer } from "@/lib/data/session";

async function LoginGate() {
  const viewer = await getViewer();
  if (viewer) redirect(HOME[viewer.role]);
  return <LoginForm />;
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-navy text-white">
        <div className="mx-auto w-full max-w-7xl px-4 py-3">
          <h1 className="text-lg font-semibold">Funding Score Layer</h1>
          <p className="text-sm text-white/70">Prototype on synthetic data. Not an official Razorpay product.</p>
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-5xl flex-1 gap-6 px-4 py-8 md:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="flex flex-col gap-3 text-sm">
          <h2 className="text-xl font-semibold text-navy">Retry schedules timed to the customer&apos;s funded day</h2>
          <p>
            When an EMI or premium debit fails for lack of funds, the layer suggests when to try again, and the merchant
            chooses. It never moves money and never changes a due date. Any failed check falls back to Razorpay&apos;s
            original retries.
          </p>
          <p className="text-muted">
            Sign in with one of the three demo accounts. Each one sees only what its role may see: a lender sees schedule
            choices, an insurer sees a date only once it is fixed, and ops sees the internal view.
          </p>
          <p>
            <Link href="/preview" className="font-medium text-action hover:underline">
              Open the engine preview
            </Link>{" "}
            <span className="text-muted">to play the fixed demo cases without signing in.</span>
          </p>
        </section>
        <section className="self-start rounded-lg border border-line bg-white px-4 py-4">
          <h2 className="mb-3 text-base font-semibold text-navy">Sign in</h2>
          <Suspense fallback={<PageLoading />}>
            <LoginGate />
          </Suspense>
        </section>
      </main>
      <Footer />
    </div>
  );
}
