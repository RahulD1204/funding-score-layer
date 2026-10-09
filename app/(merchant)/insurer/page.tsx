// Renewals dashboard (specs/02 screen 4). Insurer only. No schedule cards: the standing default
// applies at once, and merchant_cases carries a date only once it has locked (merchantView).

import { Suspense } from "react";
import { CaseList, NextDateCell, StateCell, SummaryStrip } from "@/components/cases/live";
import { PageLoading } from "@/components/shell/AppShell";
import { Chip } from "@/components/ui";
import { formatDate, formatRupees } from "@/lib/engine";
import { listCases, listProducts, productFor } from "@/lib/data/merchant";
import { requireViewer } from "@/lib/data/session";
import { endOfCover, queueSummary } from "@/lib/view/cases";

async function Renewals() {
  await requireViewer(["insurer"]);
  const [all, products] = await Promise.all([listCases(), listProducts()]);
  const rows = all.filter((r) => r.kind === "premium");
  return (
    <>
      <SummaryStrip items={queueSummary(rows).filter((s) => s.label !== "Awaiting choice")} />
      <CaseList
        rows={rows}
        base="/insurer/cases"
        empty="No failed premiums yet. Ops brings one in with the event injector."
        columns={[
          { label: "Premium", cell: (r) => formatRupees(r.amount_paise) },
          { label: "State", cell: (r) => <StateCell row={r} /> },
          {
            label: "End of cover",
            cell: (r) => {
              const cover = endOfCover(r.due_date, productFor(r, products));
              return cover ? formatDate(cover) : "—";
            },
          },
          { label: "Attempts used", cell: (r) => `${r.retries_used} of ${r.retries_allowed}` },
          { label: "Next date", cell: (r) => <NextDateCell row={r} /> },
        ]}
      />
      <p className="mt-3 text-sm text-muted">
        A next date appears the day before the attempt, once it can no longer change.
      </p>
    </>
  );
}

export default function RenewalsPage() {
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-navy">Renewals</h1>
        <Chip tone="info">Advice only</Chip>
      </div>
      <Suspense fallback={<PageLoading />}>
        <Renewals />
      </Suspense>
    </>
  );
}
