"use client";

// The event injector (specs/02 screen 8): stands in for Razorpay's failed-debit webhook.
// It offers only known reason codes and existing obligations; process-debit-event validates both
// again and accepts an event only between the due date and the day the failure is known.

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, Chip } from "@/components/ui";
import { useApi } from "@/components/actions/api";
import { addDays, daysInMonth, diffDays, formatDate, makeDate } from "@/lib/engine";

export interface InjectorObligation {
  id: string;
  label: string;
  merchant: string;
  kind: "EMI" | "premium";
  dueDay: number;
  resultDelayDays: number;
}

export interface InjectorPreset {
  name: string;
  obligationId: string;
  dueDate: string;
  reasonCode: string;
  bankText: string;
}

/** The latest due date on or before `today` for a debit due on `dueDay` each month. */
function latestDueDate(dueDay: number, today: string): string {
  const [y, m] = today.split("-").map(Number);
  const inMonth = (year: number, month: number) => makeDate(year, month, Math.min(dueDay, daysInMonth(year, month)));
  const thisMonth = inMonth(y, m);
  if (thisMonth <= today) return thisMonth;
  return m === 1 ? inMonth(y - 1, 12) : inMonth(y, m - 1);
}

export default function EventInjector({
  obligations,
  presets,
  reasonCodes,
  today,
}: {
  obligations: InjectorObligation[];
  presets: InjectorPreset[];
  reasonCodes: { code: string; meaning: string }[];
  today: string;
}) {
  const { run, pending, error, setError } = useApi();
  const [obligationId, setObligationId] = useState(presets[0]?.obligationId ?? obligations[0]?.id ?? "");
  const [dueDate, setDueDate] = useState(presets[0]?.dueDate ?? today);
  const [reasonCode, setReasonCode] = useState("insufficient_funds");
  const [bankText, setBankText] = useState("INSUFFICIENT FUNDS");
  const [result, setResult] = useState<{ caseId: string | null; words: string } | null>(null);

  const ob = useMemo(() => obligations.find((o) => o.id === obligationId), [obligations, obligationId]);
  const knownOn = ob ? addDays(dueDate, ob.resultDelayDays) : dueDate;
  const sinceDue = diffDays(dueDate, today);
  const inWindow = ob !== undefined && sinceDue >= 0 && sinceDue <= ob.resultDelayDays;

  function choose(id: string) {
    setObligationId(id);
    const next = obligations.find((o) => o.id === id);
    if (next) setDueDate(latestDueDate(next.dueDay, today));
    setResult(null);
    setError(null);
  }

  function applyPreset(p: InjectorPreset) {
    setObligationId(p.obligationId);
    setDueDate(p.dueDate);
    setReasonCode(p.reasonCode);
    setBankText(p.bankText);
    setResult(null);
    setError(null);
  }

  async function send() {
    setResult(null);
    const eventId = `OPS-${obligationId}-${dueDate}-${Date.now().toString(36)}`;
    const answer = await run("process-debit-event", {
      eventId,
      eventType: "debit.failed",
      obligationId,
      cycleDueDate: dueDate,
      reasonCode,
      bankText,
    });
    if (!answer.ok) return;
    const d = answer.data;
    const caseId = typeof d.caseId === "string" ? d.caseId : null;
    const words =
      d.ignored === "case_exists"
        ? "This cycle already has a case. Nothing new was opened."
        : d.duplicate
          ? "That event id was already received. Nothing new was opened."
          : `Case opened: ${String(d.route).replaceAll("_", " ")}, ${String(d.state).replaceAll("_", " ")}.`;
    setResult({ caseId, words });
  }

  const field = "w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm";
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="mb-1 text-xs text-muted">Seeded cases (due 2 April)</p>
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => applyPreset(p)}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                obligationId === p.obligationId && dueDate === p.dueDate ? "border-action bg-info-soft text-info" : "border-line bg-white hover:bg-canvas"
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Obligation</span>
          <select value={obligationId} onChange={(e) => choose(e.target.value)} className={field}>
            {obligations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.id} · {o.label} · {o.merchant} {o.kind}, due on the {o.dueDay}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Cycle due date</span>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Reason code</span>
          <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className={field}>
            {reasonCodes.map((r) => (
              <option key={r.code} value={r.code}>
                {r.code} ({r.meaning})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Bank&apos;s free text</span>
          <input value={bankText} maxLength={500} onChange={(e) => setBankText(e.target.value)} className={field} />
        </label>
      </div>

      <p className={`rounded-lg px-3 py-2 text-sm ${inWindow ? "bg-paid-soft text-paid" : "bg-waiting-soft text-waiting"}`}>
        A failed-debit event is accepted only from the due date ({formatDate(dueDate)}) until the day the failure is known (
        {formatDate(knownOn)}
        {ob?.resultDelayDays === 0 ? ", the same day, because UPI Autopay answers at once" : ", 2 days later on a bank mandate"}).{" "}
        {inWindow
          ? `The clock is on ${formatDate(today)}, inside that window.`
          : `The clock is on ${formatDate(today)}, outside that window. Use Reset demo below to go back to 2 April and replay.`}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void send()} disabled={pending || !obligationId}>
          {pending ? "Sending…" : "Simulate failed debit"}
        </Button>
        {result && (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <Chip tone="info">Sent</Chip>
            {result.words}
            {result.caseId && (
              <Link href={`/ops/cases/${encodeURIComponent(result.caseId)}`} className="font-medium text-action hover:underline">
                Open the case
              </Link>
            )}
          </span>
        )}
        {error && (
          <span role="alert" className="text-sm text-failed">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
