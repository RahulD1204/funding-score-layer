// Collections queue (specs/02 screen 2). Lender only. Reads merchant_cases, with the lender's own login.

import { Suspense } from "react";
import { CaseList, NextDateCell, StateCell, SummaryStrip } from "@/components/cases/live";
import { PageLoading } from "@/components/shell/AppShell";
import { Chip } from "@/components/ui";
import { formatRupees } from "@/lib/engine";
import { listCases } from "@/lib/data/merchant";
import { requireViewer } from "@/lib/data/session";
import { queueSummary } from "@/lib/view/cases";

async function Queue() {
  await requireViewer(["lender"]);
  const rows = (await listCases()).filter((r) => r.kind === "EMI");
  return (
    <>
      <SummaryStrip items={queueSummary(rows)} />
      <CaseList
        rows={rows}
        base="/lender/cases"
        empty="No failed EMIs yet. Ops brings one in with the event injector."
        columns={[
          { label: "EMI", cell: (r) => formatRupees(r.amount_paise) },
          { label: "State", cell: (r) => <StateCell row={r} /> },
          { label: "Next date", cell: (r) => <NextDateCell row={r} /> },
          { label: "Retries used", cell: (r) => `${r.retries_used} of ${r.retries_allowed}` },
          {
            label: "Chosen schedule",
            cell: (r) =>
              r.chosen_schedule ? (
                <span>
                  {r.chosen_schedule}
                  <span className="block text-xs text-muted">{r.chosen_by === "default" ? "Standing default" : "Your pick"}</span>
                </span>
              ) : (
                <span className="text-muted">—</span>
              ),
          },
        ]}
      />
      <p className="mt-3 text-sm text-muted">February and March are replayed history on synthetic data.</p>
    </>
  );
}

export default function CollectionsQueuePage() {
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-navy">Collections queue</h1>
        <Chip tone="info">Advice only, you decide</Chip>
      </div>
      <Suspense fallback={<PageLoading />}>
        <Queue />
      </Suspense>
    </>
  );
}
