// The parts of a live case screen, drawn from merchant rows only (merchant_cases, schedule_options,
// products, merchants). Same look as the engine preview. Nothing here decides a rule: dates and
// texts come from lib/engine through lib/view/cases.ts.

import Link from "next/link";
import type { ReactNode } from "react";
import { ACTION_KIND_WORDS } from "@/lib/demo/words";
import { buildCards, formatDate, formatDay, formatRupees } from "@/lib/engine";
import type { MerchantCaseRow, ProductRow } from "@/lib/data/rows";
import { endOfCover, failedRetries, messageSourceWords, stateChip } from "@/lib/view/cases";
import { Chip, Fact, Panel } from "@/components/ui";

export const caseHref = (base: string, caseId: string) => `${base}/${encodeURIComponent(caseId)}`;

const PAID_VIA = { debit: "by debit", link: "through the payment link", outside: "outside the plan" } as const;

function nextWords(row: MerchantCaseRow): string {
  if (!row.next_date) return "";
  return `${ACTION_KIND_WORDS[row.next_action_kind ?? "attempt"]} on ${formatDate(row.next_date)}`;
}

export function CaseHeader({
  row,
  merchantName,
  product,
  viewer,
}: {
  row: MerchantCaseRow;
  merchantName: string;
  product: ProductRow | null;
  viewer: "lender" | "insurer" | "ops";
}) {
  const chip = stateChip(row.state);
  const cover = endOfCover(row.due_date, product);
  return (
    <section className="rounded-lg border border-line bg-white px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted">
            {row.case_id} · {merchantName}
          </p>
          <h2 className="text-lg font-semibold text-navy">{row.customer_label}</h2>
        </div>
        <Chip tone={chip.tone}>{chip.label}</Chip>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {product && <Fact label="Product">{product.name}</Fact>}
        <Fact label={row.kind === "EMI" ? "EMI" : "Premium"}>{formatRupees(row.amount_paise)}</Fact>
        <Fact label="Due date">{formatDate(row.due_date)}</Fact>
        <Fact label="Failed because">{row.failure_words ?? "Reason unclear"}</Fact>
        <Fact label={row.kind === "EMI" ? "Retries used" : "Attempts used"}>
          {row.retries_used} of {row.retries_allowed}
        </Fact>
        {row.kind === "EMI" && product && (
          <Fact label={viewer === "lender" ? "Your overdue cap" : "Lender's overdue cap"}>
            {formatDay(row.due_date, product.last_allowed_day)}
          </Fact>
        )}
        {row.kind === "premium" && cover && <Fact label="Cover continues until">{formatDate(cover)}</Fact>}
      </dl>
    </section>
  );
}

/** The greyed row: Razorpay's original retries, for comparison (specs/00 "What a card shows"). */
export function OriginalRetriesRow({ row, product }: { row: MerchantCaseRow; product: ProductRow }) {
  const { baseline } = buildCards([], {
    penalChargePerDayPaise: product.penal_charge_per_day_paise,
    bounceChargePaise: product.bounce_charge_paise,
    baselineRetryDays: product.baseline_retry_days,
  });
  return (
    <div className="mt-3 rounded-lg border border-dashed border-line bg-canvas px-3 py-2 text-sm text-muted">
      <span className="font-medium text-idle">Razorpay&apos;s original retries, for comparison:</span>{" "}
      {baseline.days.map((d, i) => (
        <span key={d}>
          {i > 0 && ", "}
          {formatDay(row.due_date, d)}
          {baseline.waitingChargePaise[i] != null && ` (${d} days overdue, ${formatRupees(baseline.waitingChargePaise[i] as number)})`}
        </span>
      ))}
      .
      {baseline.bounceChargePaise != null &&
        ` Each failed attempt adds your bounce charge of ${formatRupees(baseline.bounceChargePaise)} for the borrower.`}
    </div>
  );
}

/** The plan as the merchant tables hold it (decided 10 October 2026: no per-attempt history for merchants). */
export function PlanPanel({ row, plannedDays }: { row: MerchantCaseRow; plannedDays: number[] | null }) {
  const closed = row.state === "paid" || row.state === "failed";
  return (
    <Panel title={row.kind === "EMI" ? "Plan" : "Attempts"}>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {row.chosen_schedule && (
          <Fact label="Schedule">
            {row.chosen_schedule}, {row.chosen_by === "default" ? "applied by default" : "your pick"}
          </Fact>
        )}
        {plannedDays && plannedDays.length > 0 && (
          <Fact label="Planned dates">{plannedDays.map((d) => formatDay(row.due_date, d)).join(", ")}</Fact>
        )}
        <Fact label="Next">
          {closed
            ? "Nothing more"
            : row.next_date
              ? nextWords(row)
              : row.kind === "premium" && row.state === "scheduled"
                ? "Shown once the date is fixed"
                : "None planned"}
        </Fact>
        {row.result_due_date && <Fact label="Bank result due">{formatDate(row.result_due_date)}</Fact>}
        <Fact label={row.kind === "EMI" ? "Retries used" : "Attempts used"}>
          {row.retries_used} of {row.retries_allowed}
        </Fact>
      </dl>
      {row.kind === "premium" && !closed && !row.next_date && row.state === "scheduled" && (
        <p className="mt-3 text-sm text-muted">
          Retries are being timed for this premium. A date appears here the day before the attempt, when it can no longer
          change.
        </p>
      )}
    </Panel>
  );
}

export function CustomerMessagePanel({ row }: { row: MerchantCaseRow }) {
  const source = messageSourceWords(row);
  return (
    <Panel title="Message to the customer" aside={source && <span className="text-xs text-muted">{source}</span>}>
      {row.customer_message ? (
        <>
          <p className="max-w-prose rounded-lg bg-canvas px-3 py-2 text-sm">{row.customer_message}</p>
          {row.customer_message_date && <p className="mt-1 text-xs text-muted">Written on {formatDate(row.customer_message_date)}</p>}
        </>
      ) : (
        <p className="text-sm text-muted">A message is written when the next date is fixed, the day before it runs.</p>
      )}
      <p className="mt-2 text-xs text-muted">
        Every fact comes from the template. The message never mentions pay, income or account balance.
      </p>
    </Panel>
  );
}

export function OutcomePanel({ row, product }: { row: MerchantCaseRow; product: ProductRow | null }) {
  if (row.state !== "paid" && row.state !== "failed") return null;
  const failed = failedRetries(row);
  const bounce = product?.bounce_charge_paise ?? null;
  return (
    <Panel title="Outcome">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Fact label="Result">
          {row.paid_date ? (
            `Collected on ${formatDate(row.paid_date)} ${row.paid_via ? PAID_VIA[row.paid_via] : ""}`
          ) : (
            <span className="text-failed">Not collected inside the limits</span>
          )}
        </Fact>
        <Fact label={row.kind === "EMI" ? "Failed retries" : "Failed attempts"}>{failed}</Fact>
        {row.kind === "EMI" && bounce !== null && <Fact label="Bounce charges to the borrower">{formatRupees(failed * bounce)}</Fact>}
      </dl>
    </Panel>
  );
}

export function OriginalRetriesPanel({ row, product }: { row: MerchantCaseRow; product: ProductRow | null }) {
  return (
    <Panel title="Razorpay's original retries apply">
      <p className="text-sm text-muted">The layer made no suggestion for this debit. Nothing changes from today&apos;s process.</p>
      {product && (
        <p className="mt-2 text-sm">
          Retries on {product.baseline_retry_days.map((d) => formatDay(row.due_date, d)).join(", ")}.
        </p>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The queue: a table on a wide screen, a list of rows on a phone (no sideways scrolling)
// ---------------------------------------------------------------------------

export interface Column {
  label: string;
  cell: (row: MerchantCaseRow) => ReactNode;
}

export function CaseList({ rows, base, columns, empty }: { rows: MerchantCaseRow[]; base: string; columns: Column[]; empty: string }) {
  if (rows.length === 0) return <p className="rounded-lg border border-line bg-white px-3 py-6 text-center text-sm text-muted">{empty}</p>;
  return (
    <div className="rounded-lg border border-line bg-white">
      <table className="hidden w-full text-left text-sm md:table">
        <thead className="text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Customer</th>
            {columns.map((c) => (
              <th key={c.label} className="px-3 py-2 font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.case_id} className="border-t border-line hover:bg-canvas">
              <td className="px-3 py-2">
                <Link href={caseHref(base, row.case_id)} className="font-medium text-action hover:underline">
                  {row.customer_label}
                </Link>
                <span className="block text-xs text-muted">{row.case_id}</span>
              </td>
              {columns.map((c) => (
                <td key={c.label} className="px-3 py-2">
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="md:hidden">
        {rows.map((row) => (
          <li key={row.case_id} className="border-b border-line px-3 py-2.5 last:border-b-0">
            <Link href={caseHref(base, row.case_id)} className="font-medium text-action hover:underline">
              {row.customer_label}
            </Link>
            <span className="ml-2 text-xs text-muted">{row.case_id}</span>
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              {columns.map((c) => (
                <div key={c.label} className="min-w-0">
                  <dt className="text-xs text-muted">{c.label}</dt>
                  <dd>{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StateCell({ row }: { row: MerchantCaseRow }) {
  const chip = stateChip(row.state);
  return <Chip tone={chip.tone}>{chip.label}</Chip>;
}

export function NextDateCell({ row }: { row: MerchantCaseRow }) {
  if (row.state === "paid" && row.paid_date) return <span className="text-muted">Paid {formatDate(row.paid_date)}</span>;
  if (!row.next_date) return <span className="text-muted">—</span>;
  return <span className="whitespace-nowrap">{nextWords(row)}</span>;
}

export function SummaryStrip({ items }: { items: { label: string; value: number }[] }) {
  return (
    <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map((s) => (
        <div key={s.label} className="rounded-lg border border-line bg-white px-3 py-2">
          <dt className="text-xs text-muted">{s.label}</dt>
          <dd className="text-xl font-semibold text-navy">{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}
