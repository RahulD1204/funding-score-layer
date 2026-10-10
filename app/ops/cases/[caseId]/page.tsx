// The internal case view (specs/02 screen 8). Ops only. The triage view (label, evidence, rule or
// agent), the decision and its estimate, the plan's actions, the activity, the customer messages
// with how each was worded, the audit rows, the customer's signed link, and below them what the
// merchant sees.

import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CaseHeader, PlanPanel } from "@/components/cases/live";
import ScheduleCardView from "@/components/cases/ScheduleCardView";
import { PageLoading } from "@/components/shell/AppShell";
import { Chip, Fact, Panel } from "@/components/ui";
import { ACTION_KIND_WORDS, ACTION_STATUS_WORDS, eventText, failOpenWords } from "@/lib/demo/words";
import { addDays, formatDate, formatDay, type ActionKind, type ActionStatus } from "@/lib/engine";
import { listProducts, productFor } from "@/lib/data/merchant";
import { getCase, type MessageRow } from "@/lib/data/ops";
import { requireViewer } from "@/lib/data/session";
import { customerToken } from "@/lib/server/customer-link";
import { cardFromRow } from "@/lib/view/cases";

const DECISION_WORDS: Record<string, string> = {
  schedules: "Schedules built",
  out_of_reach: "Out of reach: payment link",
  exceptions_desk: "Sent to the exceptions desk",
  fail_open: "Fail open: Razorpay's original retries",
  needs_agent: "Fail open: the Triage agent gave no answer",
};

/** How a stored message was worded: the template, or polish and what validatePolish made of it. */
function messageNote(m: MessageRow): string {
  const link = m.facts?.type === "link";
  const what = link ? "Payment link" : "Retry notice";
  const polish = m.facts?.polish;
  const how = link
    ? "template, a link's text is never polished"
    : m.source === "polished"
      ? "polished wording, accepted by validatePolish"
      : !polish
        ? "template, polish off"
        : polish.status === "rejected"
          ? `template kept, rewrite rejected (${polish.problems.join("; ")})`
          : `template kept, polish ${polish.status.replaceAll("_", " ")}`;
  return `${what} · ${how} · template ${m.template_version} · ${m.channel.replaceAll("_", " ")}`;
}

interface OpenedInputs {
  estimate?: { source: string; h: number; u: number; confidence: number; floor: number; deductions: { affordability: number; drift: number }; salaryRecognized: boolean } | null;
  gate?: { tier: string; failed: string[] } | null;
}

async function OpsCase({ params }: { params: Promise<{ caseId: string }> }) {
  await requireViewer(["ops"]);
  const caseId = decodeURIComponent((await params).caseId);
  const [detail, products] = await Promise.all([getCase(caseId), listProducts()]);
  if (!detail) notFound();
  const { rec, actions, events, triage, audit, merchantRow, options, messages, prediction } = detail;
  const due = rec.cycle_due_date;
  const opened = audit.find((a) => a.decision.startsWith("case_opened"));
  const inputs = (opened?.inputs ?? {}) as OpenedInputs;
  const e = inputs.estimate ?? null;
  const event = events[0];
  const t = triage[0];
  const sim = rec.sim_snapshot;
  const product = merchantRow ? productFor(merchantRow, products) : null;
  const cards = options.map(cardFromRow);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-navy">
          {rec.obligations.customers.label} <span className="text-base font-normal text-muted">· {rec.id}</span>
        </h1>
        <Link href={`/c/${customerToken(rec.id)}`} target="_blank" className="text-sm font-medium text-action hover:underline">
          Open the customer&apos;s phone (signed link)
        </Link>
      </div>

      <Panel tone="internal" title="Internal view" aside={<span className="text-xs font-medium text-navy">Razorpay ops only. Never shown to a merchant.</span>}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Reason code and bank text">
            {event ? (
              <>
                {event.reason_code} · &ldquo;{event.bank_text ?? ""}&rdquo;
              </>
            ) : (
              "No event"
            )}
          </Fact>
          <Fact label="Triage label">
            {t ? `${t.label}, decided by ${t.decided_by}${t.agent_strength ? ` (${t.agent_strength})` : ""}` : "Not triaged"}
          </Fact>
          <Fact label="Decision">{DECISION_WORDS[rec.route] ?? rec.route}</Fact>
          {rec.fail_open_reason && <Fact label="Why the layer stepped back">{failOpenWords(rec.fail_open_reason)}</Fact>}
          {inputs.gate && (
            <Fact label="Evidence gate">
              Tier {inputs.gate.tier}
              {inputs.gate.failed.length > 0 && ` (${inputs.gate.failed.join(", ").replaceAll("_", " ")})`}
            </Fact>
          )}
          {e && (
            <>
              <Fact label="Funded-day estimate">
                {formatDate(addDays(due, e.h))}, {e.h} days after the due date
              </Fact>
              <Fact label="Based on">
                {e.source === "salary" ? "A recognized monthly credit" : e.source === "model" ? "Model score" : "Payment history"}
              </Fact>
              <Fact label="Confidence against the floor">
                {e.confidence}% against {e.floor}%
                {(e.deductions.affordability > 0 || e.deductions.drift > 0) && ` (after −${e.deductions.affordability + e.deductions.drift})`}
              </Fact>
              <Fact label="Upper day">{formatDay(due, e.u)}</Fact>
            </>
          )}
          <Fact label="Policy version">{rec.policy_version}</Fact>
          <Fact label="Model version">{prediction ? `${prediction.model_version} (${prediction.source})` : "None"}</Fact>
          {rec.standing_default && <Fact label="Standing default at opening">{rec.standing_default}</Fact>}
        </dl>
        {t?.evidence && t.evidence.length > 0 && (
          <div className="mt-3 border-t border-line pt-2 text-sm">
            <p className="text-xs text-muted">Triage evidence</p>
            <p>{t.evidence.join(" · ")}</p>
          </div>
        )}
        {opened?.internal_reason && (
          <div className="mt-2 text-sm">
            <p className="text-xs text-muted">Audit reason</p>
            <p>{opened.internal_reason}</p>
          </div>
        )}
      </Panel>

      {actions.length > 0 && (
        <Panel tone="internal" title="Plan actions">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Date</th>
                <th className="py-1 pr-3 font-medium">Action</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 font-medium">Result known</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => {
                const status = ACTION_STATUS_WORDS[a.status as ActionStatus];
                return (
                  <tr key={a.action_number} className="border-t border-line">
                    <td className="py-1.5 pr-3 font-medium whitespace-nowrap">{formatDay(due, a.day)}</td>
                    <td className="py-1.5 pr-3">{ACTION_KIND_WORDS[a.kind as ActionKind]}</td>
                    <td className="py-1.5 pr-3">{status && <Chip tone={status.tone}>{status.label}</Chip>}</td>
                    <td className="py-1.5 whitespace-nowrap text-muted">{a.result_due_day !== null ? formatDay(due, a.result_due_day) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}

      {sim && sim.log.length > 0 && (
        <Panel tone="internal" title="Activity">
          <ol className="flex flex-col gap-1.5 text-sm">
            {sim.log.map((entry, i) => (
              <li key={i} className="grid grid-cols-[5.5rem_1fr] gap-2">
                <span className="whitespace-nowrap text-muted">{formatDay(due, entry.day)}</span>
                <span>{eventText(entry, due)}</span>
              </li>
            ))}
          </ol>
        </Panel>
      )}

      {messages.length > 0 && (
        <Panel tone="internal" title={`Customer messages (${messages.length})`}>
          <ol className="flex flex-col gap-2 text-sm">
            {messages.map((m) => (
              <li key={m.id} className="grid grid-cols-[5.5rem_1fr] gap-2">
                <span className="whitespace-nowrap text-muted">{formatDate(m.clock_date)}</span>
                <span>
                  <span className="block">{m.body}</span>
                  <span className="block text-xs text-muted">{messageNote(m)}</span>
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      )}

      <Panel
        tone="internal"
        title={`Audit rows (${audit.length})`}
        aside={
          <Link href={`/ops/audit?q=${encodeURIComponent(rec.id)}`} className="text-xs font-medium text-action hover:underline">
            Open in the audit log
          </Link>
        }
      >
        <ol className="flex flex-col gap-1.5 text-sm">
          {audit.map((a) => (
            <li key={a.id} className="grid grid-cols-[5.5rem_1fr] gap-2">
              <span className="whitespace-nowrap text-muted">{formatDate(a.clock_date)}</span>
              <span>
                <span className="font-medium">{a.decision}</span> · {a.actor}
                {a.internal_reason && <span className="block text-muted">{a.internal_reason}</span>}
              </span>
            </li>
          ))}
        </ol>
      </Panel>

      {merchantRow && (
        <>
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">What {rec.obligations.merchants.name} sees</p>
          <CaseHeader row={merchantRow} merchantName={rec.obligations.merchants.name} product={product} viewer="ops" />
          {cards.length > 0 && (
            <div className="grid gap-3 md:grid-cols-3">
              {cards.map((card) => (
                <ScheduleCardView
                  key={card.label}
                  card={card}
                  dueDate={due}
                  penalChargePerDayPaise={product?.penal_charge_per_day_paise ?? null}
                  originalFirstDay={product?.baseline_retry_days[0]}
                  chosen={merchantRow.chosen_schedule !== null && card.labels.includes(merchantRow.chosen_schedule)}
                  chosenBy={merchantRow.chosen_by}
                  isDefault={product ? card.labels.includes(product.standing_default) : false}
                />
              ))}
            </div>
          )}
          <PlanPanel row={merchantRow} plannedDays={null} />
        </>
      )}

      <p>
        <Link href="/ops" className="text-sm font-medium text-action hover:underline">
          Back to the console
        </Link>
      </p>
    </div>
  );
}

export default function OpsCasePage({ params }: PageProps<"/ops/cases/[caseId]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <OpsCase params={params} />
    </Suspense>
  );
}
