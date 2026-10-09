"use client";

// One case, as the signed-in role would see it.
// Merchant sections read only `c.merchant` and the case state. The internal panel reads `c.ops`
// and is rendered for the ops role alone.

import { addDays, formatDate, formatDay, formatRupees } from "@/lib/engine/dates";
import { buildRetryMessage, fillTemplate } from "@/lib/engine/messages";
import { resolveOption, type ScheduleCard } from "@/lib/engine/schedule";
import {
  lastPickDay,
  merchantView,
  outcomeOf,
  pickSchedule,
  simulateBaseline,
  type SimAction,
  type SimCase,
} from "@/lib/engine/simulate";
import type { ScheduleLabel } from "@/lib/engine/policy";
import type { FixType } from "@/lib/engine/desk";
import type { PreparedCase } from "@/lib/demo/prepare";
import {
  ACTION_KIND_WORDS,
  ACTION_STATUS_WORDS,
  STATE_WORDS,
  eventText,
  failOpenWords,
  type Tone,
} from "@/lib/demo/words";
import { Button, Chip, Fact, Panel } from "@/components/ui";
import ScheduleCardView from "@/components/cases/ScheduleCardView";

export type Role = "lender" | "insurer" | "ops";

export interface CaseDetailProps {
  c: PreparedCase;
  sim: SimCase | null;
  day: number;
  role: Role;
  approvedFixes: Record<string, boolean>;
  onPick: (label: ScheduleLabel) => void;
  onPaidOutside: () => void;
  onUseOriginal: () => void;
  onApproveFix: (fix: FixType) => void;
}

export function caseChip(c: PreparedCase, sim: SimCase | null, approvedFixes: Record<string, boolean>) {
  if (sim) return STATE_WORDS[sim.state];
  if (c.merchant.route === "exceptions_desk") {
    const open = c.merchant.desk?.proposals.some((p) => p.mode === "needs_approval" && !approvedFixes[`${c.id}:${p.fix}`]);
    return open ? { label: "Needs action", tone: "waiting" as Tone } : { label: "Fix approved", tone: "info" as Tone };
  }
  return { label: "Original retries", tone: "idle" as Tone };
}

export default function CaseDetail(props: CaseDetailProps) {
  const { c, sim, role } = props;
  const m = c.merchant;
  const chip = caseChip(c, sim, props.approvedFixes);
  const due = m.dueDate;
  const used = sim ? outcomeOf(sim).debitsPresented : 0;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-line bg-white px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs text-muted">
              {c.id} · {m.merchantName}
            </p>
            <h2 className="text-lg font-semibold text-navy">{m.customer}</h2>
          </div>
          <Chip tone={chip.tone}>{chip.label}</Chip>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label="Product">{m.product}</Fact>
          <Fact label={m.kind === "EMI" ? "EMI" : "Premium"}>{formatRupees(m.amountPaise)}</Fact>
          <Fact label="Due date">{formatDate(due)}</Fact>
          <Fact label="Failed because">{m.failureReason}</Fact>
          {sim && (
            <Fact label="Retries used">
              {used} of {m.maxRepresentations}
            </Fact>
          )}
          {m.merchantType === "lender" ? (
            <Fact label={role === "lender" ? "Your overdue cap" : "Lender's overdue cap"}>{formatDay(due, m.lastAllowedDay)}</Fact>
          ) : (
            <Fact label="Cover continues until">{formatDay(due, m.graceEndDay ?? m.lastAllowedDay)}</Fact>
          )}
        </dl>
      </section>

      <p className="rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted">
        <span className="font-medium text-ink">Demo note, not part of the product.</span> {c.teaches}
      </p>

      {role === "ops" && <InternalPanel c={c} />}

      {role === "ops" && (
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          What {m.merchantName} sees
        </p>
      )}

      {sim && m.merchantType === "lender" && <LenderPlan {...props} sim={sim} />}
      {sim && m.merchantType === "insurer" && <InsurerPlan {...props} sim={sim} />}
      {!sim && m.route === "exceptions_desk" && <DeskPanel {...props} />}
      {!sim && m.route === "original_retries" && <OriginalRetries {...props} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lender
// ---------------------------------------------------------------------------

function LenderPlan(props: CaseDetailProps & { sim: SimCase }) {
  const { c, sim, role } = props;
  const m = c.merchant;
  const due = m.dueDate;
  const closed = sim.state === "paid" || sim.state === "failed";
  const acting = sim.state !== "normal_retries" && sim.state !== "needs_action" && !closed;
  const defaultOption = resolveOption(sim.options, m.standingDefault);

  return (
    <>
      {m.route === "schedules" && (
        <Panel
          title="Suggested retry schedules"
          aside={<Chip tone="info">Advice only, you decide</Chip>}
        >
          <p className="text-sm text-muted">{m.publicReason}</p>
          {sim.state === "awaiting_choice" && defaultOption && (
            <p className="mt-1 text-sm">
              If you don&apos;t pick, <span className="font-medium">{m.standingDefault}</span> applies on{" "}
              <span className="font-medium">{formatDay(due, defaultOption.firstActionDay - 1)}</span>.
            </p>
          )}
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {m.cards.map((card) => (
              <PreviewCard
                key={card.label}
                card={card}
                c={c}
                sim={sim}
                canPick={role === "lender" && pickSchedule(sim, card.label).ok}
                showPick={role === "lender" && acting}
                onPick={() => props.onPick(card.label)}
              />
            ))}
          </div>
          {m.baseline && (
            <div className="mt-3 rounded-lg border border-dashed border-line bg-canvas px-3 py-2 text-sm text-muted">
              <span className="font-medium text-idle">Razorpay&apos;s original retries, for comparison:</span>{" "}
              {m.baseline.days.map((d, i) => (
                <span key={d}>
                  {i > 0 && ", "}
                  {formatDay(due, d)}
                  {m.baseline?.waitingChargePaise[i] != null &&
                    ` (${d} days overdue, ${formatRupees(m.baseline.waitingChargePaise[i] as number)})`}
                </span>
              ))}
              .
              {m.baseline.bounceChargePaise != null &&
                ` Each failed attempt adds your bounce charge of ${formatRupees(m.baseline.bounceChargePaise)} for the borrower.`}
            </div>
          )}
        </Panel>
      )}

      {m.route === "out_of_reach" && (
        <Panel title="No retry schedule for this EMI" aside={<Chip tone="info">Advice only, you decide</Chip>}>
          <p className="text-sm">
            A retry inside your overdue cap of {formatDay(due, m.lastAllowedDay)} is unlikely to be funded, so no debit is
            planned. A payment link is sent instead, timed from payment patterns.
          </p>
        </Panel>
      )}

      <PlanTable sim={sim} due={due} showAll />
      {sim.state === "normal_retries" && sim.baselineRemaining.length > 0 && (
        <Panel title="Razorpay's original retries resume">
          <p className="text-sm">
            Next attempts: {sim.baselineRemaining.map((d) => formatDay(due, d)).join(", ")}.
          </p>
        </Panel>
      )}
      <CustomerMessage c={c} sim={sim} />
      <Outcome c={c} sim={sim} />
      <Activity sim={sim} due={due} />

      {role === "lender" && acting && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={props.onPaidOutside}
            disabled={sim.actions.some((a) => a.status === "in_flight")}
            title="Refused while a debit is unresolved, so the borrower is never charged twice"
          >
            Mark as paid outside the plan
          </Button>
          <Button variant="secondary" onClick={props.onUseOriginal}>
            Use Razorpay&apos;s original retries for this case
          </Button>
        </div>
      )}
    </>
  );
}

function PreviewCard({
  card,
  c,
  sim,
  canPick,
  showPick,
  onPick,
}: {
  card: ScheduleCard;
  c: PreparedCase;
  sim: SimCase;
  canPick: boolean;
  showPick: boolean;
  onPick: () => void;
}) {
  const m = c.merchant;
  const chosen = sim.chosen !== null && card.labels.includes(sim.chosen);
  return (
    <ScheduleCardView
      card={card}
      dueDate={m.dueDate}
      penalChargePerDayPaise={m.penalChargePerDayPaise}
      originalFirstDay={m.baselineRetryDays[0]}
      chosen={chosen}
      chosenBy={sim.chosenBy}
      isDefault={card.labels.includes(m.standingDefault)}
      footer={
        showPick && (
          <>
            <span className="text-xs text-muted">
              {canPick ? `Pick by ${formatDay(m.dueDate, lastPickDay(card.attemptDays[0]))}` : chosen ? "Locked in" : "Too close to pick"}
            </span>
            <Button onClick={onPick} disabled={!canPick || chosen}>
              {chosen ? "Picked" : "Use this schedule"}
            </Button>
          </>
        )
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Insurer
// ---------------------------------------------------------------------------

function InsurerPlan({ c, sim }: CaseDetailProps & { sim: SimCase }) {
  const m = c.merchant;
  const due = m.dueDate;
  const view = merchantView(sim);
  const closed = sim.state === "paid" || sim.state === "failed";

  return (
    <>
      <Panel title="Renewal status" aside={<Chip tone="info">Advice only</Chip>}>
        <p className="text-sm text-muted">{m.publicReason}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
          <Fact label="Next attempt">
            {closed
              ? "None"
              : view.nextActionDay !== null
                ? formatDay(due, view.nextActionDay)
                : "Shown once the date is fixed"}
          </Fact>
          <Fact label="Last day an attempt may run">{formatDay(due, m.lastAllowedDay)}</Fact>
        </dl>
        {!closed && view.nextActionDay === null && (
          <p className="mt-3 text-sm text-muted">
            Retries are being timed for this premium. A date appears here the day before the attempt, when it can no
            longer change.
          </p>
        )}
      </Panel>
      <PlanTable sim={sim} due={due} showAll={false} />
      <CustomerMessage c={c} sim={sim} />
      <Outcome c={c} sim={sim} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function PlanTable({ sim, due, showAll }: { sim: SimCase; due: string; showAll: boolean }) {
  // An insurer sees only dates that have locked or already run.
  const hiddenFromInsurer: SimAction["status"][] = ["planned", "cancelled", "dropped"];
  const rows = [...sim.actions]
    .filter((a) => showAll || !hiddenFromInsurer.includes(a.status))
    .sort((a, b) => a.day - b.day || a.id - b.id);
  if (rows.length === 0) return null;
  return (
    <Panel title={showAll ? "Plan" : "Attempts so far"}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">Date</th>
              <th className="py-1 pr-3 font-medium">Action</th>
              <th className="py-1 pr-3 font-medium">Status</th>
              <th className="py-1 font-medium">Result known</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const status = ACTION_STATUS_WORDS[a.status];
              return (
                <tr key={a.id} className="border-t border-line">
                  <td className="py-1.5 pr-3 font-medium whitespace-nowrap">{formatDay(due, a.day)}</td>
                  <td className="py-1.5 pr-3">{ACTION_KIND_WORDS[a.kind]}</td>
                  <td className="py-1.5 pr-3">
                    <Chip tone={status.tone}>{status.label}</Chip>
                  </td>
                  <td className="py-1.5 whitespace-nowrap text-muted">
                    {a.resultDueDay !== undefined ? formatDay(due, a.resultDueDay) : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function CustomerMessage({ c, sim }: { c: PreparedCase; sim: SimCase }) {
  const m = c.merchant;
  const due = m.dueDate;
  const link = sim.actions.find((a) => a.kind === "link" && a.status === "sent");
  const next = [...sim.actions]
    .filter((a) => a.kind !== "link" && (a.status === "locked" || a.status === "in_flight"))
    .sort((a, b) => b.day - a.day)[0];

  let text: string | null = null;
  if (link) {
    text = fillTemplate("payment_link", {
      kind: m.kind,
      amount: formatRupees(m.amountPaise),
      merchant: m.merchantName,
      link: "[payment link]",
    });
  } else if (next) {
    text = buildRetryMessage({
      segment: m.merchantType === "lender" ? "lending" : "insurance",
      merchantName: m.merchantName,
      amountPaise: m.amountPaise,
      dueDate: due,
      plannedDate: addDays(due, next.day),
      graceEnd: m.graceEndDay !== null ? addDays(due, m.graceEndDay) : undefined,
    }).text;
  }
  if (!text) return null;

  return (
    <Panel title="Message to the customer" aside={<span className="text-xs text-muted">Template text</span>}>
      <p className="max-w-prose rounded-lg bg-canvas px-3 py-2 text-sm">{text}</p>
      <p className="mt-2 text-xs text-muted">
        Every fact comes from the template. The message never mentions pay, income or account balance.
      </p>
    </Panel>
  );
}

function Outcome({ c, sim }: { c: PreparedCase; sim: SimCase }) {
  if (sim.state !== "paid" && sim.state !== "failed") return null;
  const m = c.merchant;
  const due = m.dueDate;
  const original = simulateBaseline(m.baselineRetryDays, m.resultDelayDays, c.world.fundedOnDay);
  const bounce = m.baseline?.bounceChargePaise ?? null;
  const via = { debit: "by debit", link: "through the payment link", outside: "outside the plan" } as const;

  const rows = [
    {
      name: "This plan",
      result:
        sim.paidDay !== null
          ? `Collected on ${formatDay(due, sim.paidDay)} ${sim.paidVia ? via[sim.paidVia] : ""}`
          : "Not collected inside the limits",
      failed: sim.failedAttempts,
      good: sim.paidDay !== null,
    },
    {
      name: "Razorpay's original retries",
      result:
        original.paidDay !== null ? `Collected on ${formatDay(due, original.paidDay)} by debit` : "Not collected in three retries",
      failed: original.failedAttempts,
      good: original.paidDay !== null,
    },
  ];

  return (
    <Panel title="Outcome" aside={<span className="text-xs text-muted">Simulated on the same customer</span>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium"></th>
              <th className="py-1 pr-3 font-medium">Result</th>
              <th className="py-1 pr-3 font-medium">Failed retries</th>
              {bounce !== null && <th className="py-1 font-medium">Bounce charges to the borrower</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-line">
                <td className="py-1.5 pr-3 font-medium">{r.name}</td>
                <td className={`py-1.5 pr-3 ${r.good ? "" : "text-failed"}`}>{r.result}</td>
                <td className="py-1.5 pr-3">{r.failed}</td>
                {bounce !== null && <td className="py-1.5">{formatRupees(r.failed * bounce)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Activity({ sim, due }: { sim: SimCase; due: string }) {
  return (
    <Panel title="Activity">
      <ol className="flex flex-col gap-1.5 text-sm">
        {sim.log.map((entry, i) => (
          <li key={i} className="grid grid-cols-[5.5rem_1fr] gap-2">
            <span className="text-muted whitespace-nowrap">{formatDay(due, entry.day)}</span>
            <span>{eventText(entry, due)}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Exceptions desk and original retries
// ---------------------------------------------------------------------------

function DeskPanel({ c, role, approvedFixes, onApproveFix }: CaseDetailProps) {
  const desk = c.merchant.desk;
  if (!desk) return null;
  return (
    <Panel title="Exceptions desk: proposed fixes" aside={<Chip tone="waiting">Retries stopped</Chip>}>
      <p className="text-sm text-muted">
        Another debit cannot succeed until this is fixed. Anything that contacts the customer waits for your approval,
        unless you set that fix type to automatic in Settings.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {desk.proposals.map((p) => {
          const approved = approvedFixes[`${c.id}:${p.fix}`];
          return (
            <li
              key={p.fix}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{p.reason}</p>
                <p className="text-xs text-muted">
                  {p.mode === "automatic" ? "Runs automatically. Does not contact the customer." : "Contacts the customer. Needs your approval."}
                </p>
              </div>
              {p.mode === "automatic" ? (
                <Chip tone="paid">Done automatically</Chip>
              ) : approved ? (
                <Chip tone="paid">Approved</Chip>
              ) : (
                <Button onClick={() => onApproveFix(p.fix)} disabled={role === "ops"}>
                  Approve
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted">Preview only: approving a fix here sends nothing.</p>
    </Panel>
  );
}

function OriginalRetries({ c, day }: CaseDetailProps) {
  const m = c.merchant;
  const due = m.dueDate;
  const original = simulateBaseline(m.baselineRetryDays, m.resultDelayDays, c.world.fundedOnDay);
  const done = new Map(original.attempts.map((a) => [a.day, a]));
  const success = original.attempts.find((a) => a.success);
  const collectedKnown = success !== undefined && success.resultDay <= day;

  const rows = m.baselineRetryDays.map((d) => {
    const attempt = done.get(d);
    let status: { label: string; tone: Tone };
    if (!attempt) status = collectedKnown ? { label: "Not needed", tone: "idle" } : { label: "Planned", tone: "idle" };
    else if (d > day) status = { label: "Planned", tone: "idle" };
    else if (attempt.resultDay > day) status = { label: "Result awaited", tone: "waiting" };
    else status = attempt.success ? { label: "Collected", tone: "paid" } : { label: "Failed", tone: "failed" };
    return { d, status };
  });

  return (
    <Panel title="Razorpay's original retries apply">
      <p className="text-sm text-muted">The layer made no suggestion for this debit. Nothing changes from today&apos;s process.</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[360px] text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">Date</th>
              <th className="py-1 pr-3 font-medium">Action</th>
              <th className="py-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ d, status }) => {
              return (
                <tr key={d} className="border-t border-line">
                  <td className="py-1.5 pr-3 font-medium whitespace-nowrap">{formatDay(due, d)}</td>
                  <td className="py-1.5 pr-3">Retry</td>
                  <td className="py-1.5">
                    <Chip tone={status.tone}>{status.label}</Chip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Internal panel, ops only
// ---------------------------------------------------------------------------

function InternalPanel({ c }: { c: PreparedCase }) {
  const o = c.ops;
  const due = c.merchant.dueDate;
  const decisionWords: Record<string, string> = {
    schedules: "Schedules built",
    out_of_reach: "Out of reach: payment link",
    exceptions_desk: "Sent to the exceptions desk",
    fail_open: "Fail open: Razorpay's original retries",
    needs_agent: "Fail open: the Triage agent gave no answer",
  };
  return (
    <Panel
      tone="internal"
      title="Internal view"
      aside={<span className="text-xs font-medium text-navy">Razorpay ops only. Never shown to a merchant.</span>}
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Reason code and bank text">
          {o.errorReason} · &ldquo;{o.bankText}&rdquo;
        </Fact>
        <Fact label="Triage label">
          {o.triage.label}, decided by {o.triage.decidedBy}
        </Fact>
        <Fact label="Decision">{decisionWords[o.decision] ?? o.decision}</Fact>
        {o.failOpenReason && <Fact label="Why the layer stepped back">{failOpenWords(o.failOpenReason)}</Fact>}
        {o.gate && (
          <Fact label="Evidence gate">
            Tier {o.gate.tier}
            {o.gate.failed.length > 0 && ` (${o.gate.failed.join(", ").replaceAll("_", " ")})`}
          </Fact>
        )}
        {o.estimate && (
          <>
            <Fact label="Funded-day estimate">
              {formatDate(o.estimate.fundedDate)}, {o.estimate.h} days after the due date
            </Fact>
            <Fact label="Based on">
              {o.estimate.source === "salary" ? "A recognized monthly credit" : o.estimate.source === "model" ? "Model score" : "Payment history"}
              {o.estimate.pattern && `, pattern around ${o.estimate.pattern}`}, {o.estimate.observationsUsed} observations
            </Fact>
            <Fact label="Confidence against the floor">
              {o.estimate.confidence}% against {o.estimate.floor}%
              {(o.estimate.deductions.affordability > 0 || o.estimate.deductions.drift > 0) &&
                ` (after −${o.estimate.deductions.affordability + o.estimate.deductions.drift})`}
            </Fact>
            <Fact label="Upper day">{formatDay(due, o.estimate.u)}</Fact>
          </>
        )}
        <Fact label="Policy version">{o.policyVersion}</Fact>
        <Fact label="Simulation truth">
          {o.truthFundedOnDay === null ? "Never funded this cycle" : `Funded from ${formatDay(due, o.truthFundedOnDay)}`}
        </Fact>
      </dl>
      <div className="mt-3 border-t border-line pt-2 text-sm">
        <p className="text-xs text-muted">Evidence</p>
        <p>{o.triage.evidence.join(" · ")}</p>
        <p className="mt-2 text-xs text-muted">Audit reason</p>
        <p>{o.internalReason}</p>
        {o.note && <p className="mt-2 text-muted">{o.note}</p>}
      </div>
    </Panel>
  );
}
