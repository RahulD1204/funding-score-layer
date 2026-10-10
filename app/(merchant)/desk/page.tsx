// Exceptions desk (specs/02 screen 5). Lender and insurer. A Needs action queue sorted by deadline:
// failure label, proposed fix, reason and mode. Reads desk_items and merchant_cases only.
// The approve buttons (components/desk/DeskQueue.tsx) run approve-fixes.

import Link from "next/link";
import { Suspense } from "react";
import { caseHref } from "@/components/cases/live";
import { PageLoading } from "@/components/shell/AppShell";
import DeskQueue, { type DeskQueueRow } from "@/components/desk/DeskQueue";
import { Chip } from "@/components/ui";
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

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-white px-3 py-6 text-center text-sm text-muted">
        Nothing needs action. Failures that waiting cannot fix, such as a cancelled mandate, appear here.
      </p>
    );
  }

  const queue: DeskQueueRow[] = rows.map(({ item, deadline }) => {
    const c = item.merchant_cases;
    const description = FIX_CATALOGUE[item.fix_type].description;
    return {
      id: item.id,
      caseHref: caseHref(base, item.case_id),
      customer: c?.customer_label ?? item.case_id,
      summary: `${c ? `${c.kind === "EMI" ? "EMI" : "Premium"} ${formatRupees(c.amount_paise)} · ` : ""}${c?.failure_words ?? item.trigger.replaceAll("_", " ")}`,
      fix: description,
      reason: item.reason !== description ? item.reason : null,
      mode: item.mode,
      deadline: deadline ? formatDate(deadline) : null,
      status: STATUS_WORDS[item.status],
      waiting: item.status === "proposed" && item.mode === "needs_approval",
    };
  });

  return (
    <>
      <p className="mb-3 text-sm text-muted">
        Anything that contacts the customer waits for your approval, unless you set that fix type to automatic in{" "}
        <Link href="/settings" className="font-medium text-action hover:underline">
          Settings
        </Link>
        . Fixes that do not contact the customer run by themselves.
      </p>
      <DeskQueue rows={queue} />
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
