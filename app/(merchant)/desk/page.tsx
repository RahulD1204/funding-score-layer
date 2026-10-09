// Exceptions desk (specs/02 screen 5). Lender and insurer. A Needs action queue sorted by deadline:
// failure label, proposed fix, reason and mode. Reads desk_items and merchant_cases only.
// The approve buttons run approve-fixes, which build step 8 adds; until then they are shown off.

import Link from "next/link";
import { Suspense } from "react";
import { caseHref } from "@/components/cases/live";
import { PageLoading } from "@/components/shell/AppShell";
import { Button, Chip } from "@/components/ui";
import { FIX_CATALOGUE, addDays, formatDate, formatRupees } from "@/lib/engine";
import { listDeskItems, listProducts, productFor } from "@/lib/data/merchant";
import type { DeskItemRow, ProductRow } from "@/lib/data/rows";
import { requireViewer } from "@/lib/data/session";
import { endOfCover } from "@/lib/view/cases";

const STATUS_WORDS: Record<DeskItemRow["status"], { label: string; tone: "waiting" | "info" | "paid" | "idle" }> = {
  proposed: { label: "Proposed", tone: "waiting" },
  approved: { label: "Approved", tone: "info" },
  done: { label: "Done", tone: "paid" },
  rejected: { label: "Rejected", tone: "idle" },
};

/** The item's deadline: as stored, or else the overdue cap of a loan or the end of cover of a premium. */
function deadlineOf(item: DeskItemRow, products: ProductRow[]): string | null {
  if (item.deadline) return item.deadline;
  const c = item.merchant_cases;
  if (!c) return null;
  const product = productFor(c, products);
  if (!product) return null;
  return c.kind === "EMI" ? addDays(c.due_date, product.last_allowed_day) : endOfCover(c.due_date, product);
}

async function Desk() {
  const viewer = await requireViewer(["lender", "insurer"]);
  const [items, products] = await Promise.all([listDeskItems(), listProducts()]);
  const rows = items
    .map((item) => ({ item, deadline: deadlineOf(item, products) }))
    .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || a.item.id - b.item.id);
  const base = viewer.role === "lender" ? "/lender/cases" : "/insurer/cases";
  const waiting = rows.filter((r) => r.item.status === "proposed" && r.item.mode === "needs_approval").length;

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-white px-3 py-6 text-center text-sm text-muted">
        Nothing needs action. Failures that waiting cannot fix, such as a cancelled mandate, appear here.
      </p>
    );
  }

  return (
    <>
      <p className="mb-3 text-sm text-muted">
        Anything that contacts the customer waits for your approval, unless you set that fix type to automatic in{" "}
        <Link href="/settings" className="font-medium text-action hover:underline">
          Settings
        </Link>
        . Fixes that do not contact the customer run by themselves.
      </p>
      <ul className="flex flex-col gap-2">
        {rows.map(({ item, deadline }) => {
          const c = item.merchant_cases;
          const status = STATUS_WORDS[item.status];
          return (
            <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line bg-white px-3 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <input type="checkbox" disabled aria-label="Select this fix" className="mt-1" />
                <div className="min-w-0">
                  <p className="text-sm">
                    <Link href={caseHref(base, item.case_id)} className="font-medium text-action hover:underline">
                      {c?.customer_label ?? item.case_id}
                    </Link>
                    <span className="text-muted">
                      {" "}
                      · {c ? `${c.kind === "EMI" ? "EMI" : "Premium"} ${formatRupees(c.amount_paise)}` : ""} ·{" "}
                      {c?.failure_words ?? item.trigger.replaceAll("_", " ")}
                    </span>
                  </p>
                  <p className="mt-1 text-sm font-medium">{FIX_CATALOGUE[item.fix_type].description}</p>
                  {item.reason !== FIX_CATALOGUE[item.fix_type].description && <p className="text-sm text-muted">{item.reason}</p>}
                  <p className="mt-1 text-xs text-muted">
                    {item.mode === "automatic" ? "Automatic: does not contact the customer." : "Needs approval: contacts the customer."}
                    {deadline && ` Deadline ${formatDate(deadline)}.`}
                  </p>
                </div>
              </div>
              <Chip tone={status.tone}>{status.label}</Chip>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button disabled>Approve selected</Button>
        <Button variant="secondary" disabled>
          Approve all ({waiting})
        </Button>
        <span className="text-xs text-muted">Approving fixes arrives with the desk agent in build step 8. Nothing is sent yet.</span>
      </div>
    </>
  );
}

export default function DeskPage() {
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-navy">Exceptions desk</h1>
        <Chip tone="waiting">Needs action, by deadline</Chip>
      </div>
      <Suspense fallback={<PageLoading />}>
        <Desk />
      </Suspense>
    </>
  );
}
