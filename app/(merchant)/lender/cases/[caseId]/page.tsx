// Case detail for a lender (specs/02 screen 3). Reads merchant tables only: merchant_cases,
// schedule_options, products and merchants, with the lender's own login.

import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import ActionButton from "@/components/actions/ActionButton";
import {
  CaseHeader,
  CustomerMessagePanel,
  OriginalRetriesPanel,
  OriginalRetriesRow,
  OutcomePanel,
  PlanPanel,
} from "@/components/cases/live";
import PickControls from "@/components/cases/PickControls";
import ScheduleCardView from "@/components/cases/ScheduleCardView";
import { PageLoading } from "@/components/shell/AppShell";
import { Chip, Panel } from "@/components/ui";
import { formatDate, formatDay } from "@/lib/engine";
import { demoToday, getCase } from "@/lib/data/merchant";
import { requireViewer } from "@/lib/data/session";
import { cardFromRow, defaultAppliesOn, pickWindow } from "@/lib/view/cases";

const ACTING = ["awaiting_choice", "scheduled", "result_pending", "link_sent"];

async function LenderCase({ params }: { params: Promise<{ caseId: string }> }) {
  await requireViewer(["lender"]);
  const caseId = decodeURIComponent((await params).caseId);
  const [detail, today] = await Promise.all([getCase(caseId), demoToday()]);
  if (!detail || detail.row.kind !== "EMI") notFound();
  const { row, options, merchant, product } = detail;

  const cards = options.map(cardFromRow);
  const chosenCard = cards.find((c) => row.chosen_schedule !== null && c.labels.includes(row.chosen_schedule)) ?? null;
  const defaultCard = product ? (cards.find((c) => c.labels.includes(product.standing_default)) ?? cards[0]) : null;
  const outOfReach = cards.length === 0 && (row.next_action_kind === "link" || row.state === "link_sent" || row.paid_via === "link");
  const planRunning = cards.length > 0 || outOfReach;
  const acting = ACTING.includes(row.state);

  return (
    <div className="flex flex-col gap-4">
      <CaseHeader row={row} merchantName={merchant.name} product={product} viewer="lender" />

      {cards.length > 0 && (
        <Panel title="Suggested retry schedules" aside={<Chip tone="info">Advice only, you decide</Chip>}>
          {row.public_reason && <p className="text-sm text-muted">{row.public_reason}</p>}
          {row.state === "awaiting_choice" && defaultCard && product && (
            <p className="mt-1 text-sm">
              If you don&apos;t pick, <span className="font-medium">{product.standing_default}</span> applies on{" "}
              <span className="font-medium">{formatDate(defaultAppliesOn(row, defaultCard))}</span>.
            </p>
          )}
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {cards.map((card) => {
              const chosen = chosenCard?.label === card.label;
              const pick = pickWindow(row, card, chosenCard, today);
              return (
                <ScheduleCardView
                  key={card.label}
                  card={card}
                  dueDate={row.due_date}
                  penalChargePerDayPaise={product?.penal_charge_per_day_paise ?? null}
                  originalFirstDay={product?.baseline_retry_days[0]}
                  chosen={chosen}
                  chosenBy={row.chosen_by}
                  isDefault={product ? card.labels.includes(product.standing_default) : false}
                  footer={
                    acting && <PickControls caseId={row.case_id} label={card.label} open={pick.open} lastDay={pick.lastDay} chosen={chosen} />
                  }
                />
              );
            })}
          </div>
          {product && <OriginalRetriesRow row={row} product={product} />}
        </Panel>
      )}

      {outOfReach && product && (
        <Panel title="No retry schedule for this EMI" aside={<Chip tone="info">Advice only, you decide</Chip>}>
          <p className="text-sm">
            A retry inside your overdue cap of {formatDay(row.due_date, product.last_allowed_day)} is unlikely to be funded,
            so no debit is planned. A payment link is sent instead, timed from payment patterns.
          </p>
        </Panel>
      )}

      {row.state === "needs_action" && (
        <Panel title="Retries stopped" aside={<Chip tone="waiting">Needs action</Chip>}>
          <p className="text-sm">
            Another debit cannot succeed until this is fixed. The proposed fixes are on the{" "}
            <Link href="/desk" className="font-medium text-action hover:underline">
              exceptions desk
            </Link>
            .
          </p>
        </Panel>
      )}

      {row.state === "normal_retries" && <OriginalRetriesPanel row={row} product={product} />}

      {planRunning && <PlanPanel row={row} plannedDays={chosenCard?.attemptDays ?? null} />}
      {planRunning && <CustomerMessagePanel row={row} merchantName={merchant.name} product={product} today={today} />}
      <OutcomePanel row={row} product={product} />

      {acting && (
        <div className="flex flex-wrap gap-3">
          <ActionButton
            route="update-controls"
            body={{ action: "mark_paid", caseId: row.case_id }}
            variant="secondary"
            disabled={row.state === "result_pending"}
            title="Refused while a debit is unresolved, so the borrower is never charged twice"
            confirm="Mark this EMI as paid outside the plan? Pending attempts are cancelled."
          >
            Mark as paid outside the plan
          </ActionButton>
          <ActionButton
            route="update-controls"
            body={{ action: "force_original_retries", caseId: row.case_id }}
            variant="secondary"
            confirm="Hand this case back to Razorpay's original retries? Pending attempts are cancelled."
          >
            Use Razorpay&apos;s original retries for this case
          </ActionButton>
        </div>
      )}

      <p>
        <Link href="/lender" className="text-sm font-medium text-action hover:underline">
          Back to the collections queue
        </Link>
      </p>
    </div>
  );
}

export default function LenderCasePage({ params }: PageProps<"/lender/cases/[caseId]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <LenderCase params={params} />
    </Suspense>
  );
}
