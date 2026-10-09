// The customer phone mock (specs/02 screen 7). No login: the signed case link in the address is the key.
// Ops opens it from the internal case view.

import { Suspense } from "react";
import PhoneMock from "@/components/customer/PhoneMock";
import { PageLoading } from "@/components/shell/AppShell";

async function Phone({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PhoneMock token={decodeURIComponent(token)} />;
}

export default function CustomerPhonePage({ params }: PageProps<"/c/[token]">) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 py-8">
      <p className="text-center text-sm text-muted">Customer phone mock. Funding Score Layer prototype, synthetic data.</p>
      <Suspense fallback={<PageLoading />}>
        <Phone params={params} />
      </Suspense>
    </div>
  );
}
