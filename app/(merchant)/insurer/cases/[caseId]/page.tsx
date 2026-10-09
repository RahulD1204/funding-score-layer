// One failed premium, as the insurer sees it. No schedule cards and no schedule options: the
// insurer cannot read schedule_options at all, and the next date shows only once it has locked.

import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import ActionButton from "@/components/actions/ActionButton";
import { CaseHeader, CustomerMessagePanel, OriginalRetriesPanel, OutcomePanel, PlanPanel } from "@/components/cases/live";
import { PageLoading } from "@/components/shell/AppShell";
import { Chip, Panel } from "@/components/ui";
import { demoToday, getCase } from "@/lib/data/merchant";
import { requireViewer } from "@/lib/data/session";

const ACTING = ["scheduled", "result_pending", "link_sent"];

async function InsurerCase({ params }: { params: Promise<{ caseId: string }> }) {
  await requireViewer(["insurer"]);
  const caseId = decodeURIComponent((await params).caseId);
  const [detail, today] = await Promise.all([getCase(caseId), demoToday()]);
  if (!detail || detail.row.kind !== "premium") notFound();
  const { row, merchant, product } = detail;
  const acting = ACTING.includes(row.state);
  const planRunning = !["normal_retries", "needs_action"].includes(row.state);

  return (
    <div className="flex flex-col gap-4">
      <CaseHeader row={row} merchantName={merchant.name} product={product} viewer="insurer" />
      {planRunning && (
        <Panel title="Renewal status" aside={<Chip tone="info">Advice only</Chip>}>
          <p className="text-sm text-muted">{row.public_reason ?? "Suggested from payment timing. Advice only."}</p>
        </Panel>
      )}
      {row.state === "needs_action" && (
        <Panel title="Retries stopped" aside={<Chip tone="waiting">Needs action</Chip>}>
          <p className="text-sm">
            The proposed fixes are on the{" "}
            <Link href="/desk" className="font-medium text-action hover:underline">
              exceptions desk
            </Link>
            .
          </p>
        </Panel>
      )}
      {row.state === "normal_retries" && <OriginalRetriesPanel row={row} product={product} />}
      {planRunning && <PlanPanel row={row} plannedDays={null} />}
      {planRunning && <CustomerMessagePanel row={row} merchantName={merchant.name} product={product} today={today} />}
      <OutcomePanel row={row} product={product} />
      {acting && (
        <div className="flex flex-wrap gap-3">
          <ActionButton
            route="update-controls"
            body={{ action: "mark_paid", caseId: row.case_id }}
            variant="secondary"
            disabled={row.state === "result_pending"}
            confirm="Mark this premium as paid outside the plan? Pending attempts are cancelled."
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
        <Link href="/insurer" className="text-sm font-medium text-action hover:underline">
          Back to renewals
        </Link>
      </p>
    </div>
  );
}

export default function InsurerCasePage({ params }: PageProps<"/insurer/cases/[caseId]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <InsurerCase params={params} />
    </Suspense>
  );
}
