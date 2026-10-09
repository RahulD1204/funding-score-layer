"use client";

// Engine preview: the three roles on one page, with a simulated clock.
// There is no sign-in and no database here. Each case is evaluated by the real engine in
// lib/engine, and the clock runs the same state machine the server functions will wrap.

import { useMemo, useState } from "react";
import { formatDay, formatRupees } from "@/lib/engine/dates";
import type { ScheduleLabel } from "@/lib/engine/policy";
import type { FixType } from "@/lib/engine/desk";
import { advanceDay, pickSchedule, recordOutsidePayment, stopLayer, type SimCase } from "@/lib/engine/simulate";
import type { PreparedCase } from "@/lib/demo/prepare";
import type { Tone } from "@/lib/demo/words";
import CaseDetail, { caseChip, type Role } from "./CaseDetail";
import { Button, Chip } from "./ui";

const ROLES: { id: Role; label: string; who: string }[] = [
  { id: "lender", label: "Lender", who: "Northfield Finance, collections" },
  { id: "insurer", label: "Insurer", who: "Harbour Life, renewals" },
  { id: "ops", label: "Razorpay ops", who: "Internal console" },
];

const LAST_DAY = 28;

type Sims = Record<string, SimCase | null>;

export default function PreviewApp({ cases, startDay }: { cases: PreparedCase[]; startDay: number }) {
  const initial = useMemo<Sims>(() => Object.fromEntries(cases.map((c) => [c.id, c.sim])), [cases]);
  const dueDate = cases[0]?.merchant.dueDate ?? "2026-04-02";

  const [role, setRole] = useState<Role>("lender");
  const [day, setDay] = useState(startDay);
  const [sims, setSims] = useState<Sims>(initial);
  const [approvedFixes, setApprovedFixes] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<Role, string | null>>({ lender: null, insurer: null, ops: null });
  const [notice, setNotice] = useState<string | null>(null);

  const visible = cases.filter((c) => role === "ops" || c.merchant.merchantType === role);
  const current = visible.find((c) => c.id === selected[role]) ?? visible[0];

  function nextDay() {
    if (day >= LAST_DAY) return;
    const target = day + 1;
    setDay(target);
    setNotice(null);
    setSims((prev) => {
      const next: Sims = {};
      for (const c of cases) {
        const sim = prev[c.id];
        next[c.id] = sim && sim.today < target ? advanceDay(sim, c.world) : sim;
      }
      return next;
    });
  }

  function reset() {
    setDay(startDay);
    setSims(initial);
    setApprovedFixes({});
    setNotice(null);
  }

  function update(id: string, change: (sim: SimCase) => { sim: SimCase } | { error: string }) {
    const sim = sims[id];
    if (!sim) return;
    const result = change(sim);
    if ("error" in result) {
      setNotice(result.error);
      return;
    }
    setNotice(null);
    setSims((prev) => ({ ...prev, [id]: result.sim }));
  }

  function onPick(c: PreparedCase, label: ScheduleLabel) {
    update(c.id, (sim) => {
      const r = pickSchedule(sim, label);
      return r.ok ? { sim: r.case } : { error: "That schedule can no longer be picked: its first date is too close." };
    });
  }

  function onPaidOutside(c: PreparedCase) {
    update(c.id, (sim) => {
      const r = recordOutsidePayment(sim, "outside");
      return r.ok
        ? { sim: r.case }
        : { error: "A debit is waiting for its result. Marking the cycle paid now could charge the borrower twice." };
    });
  }

  function onUseOriginal(c: PreparedCase) {
    update(c.id, (sim) => ({ sim: stopLayer(sim, "forced_normal_retries", c.merchant.baselineRetryDays) }));
  }

  const counts = summarize(visible, sims, approvedFixes);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-navy text-white">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold">Funding Score Layer</h1>
            <p className="text-sm text-white/70">Prototype on synthetic data. Not an official Razorpay product.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">
              <span className="text-white/70">Simulated date </span>
              <span className="font-semibold">{formatDay(dueDate, day)} 2026</span>
            </div>
            <Button onClick={nextDay} disabled={day >= LAST_DAY}>
              Next day
            </Button>
            <button
              type="button"
              onClick={reset}
              className="rounded-lg border border-white/30 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/10"
            >
              Reset
            </button>
          </div>
        </div>
        <nav className="mx-auto flex w-full max-w-7xl gap-1 px-4" aria-label="Role">
          {ROLES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                setRole(r.id);
                setNotice(null);
              }}
              aria-current={role === r.id ? "page" : undefined}
              className={`rounded-t-lg px-3 py-2 text-left text-sm ${
                role === r.id ? "bg-canvas font-semibold text-navy" : "text-white/80 hover:bg-white/10"
              }`}
            >
              {r.label}
              <span className={`hidden text-xs font-normal sm:block ${role === r.id ? "text-muted" : "text-white/60"}`}>
                {r.who}
              </span>
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4">
        <p className="mb-4 rounded-lg border border-line bg-white px-3 py-2 text-sm text-muted">
          <span className="font-medium text-ink">Engine preview.</span> Debits fell due on 2 April 2026 and failed. Press{" "}
          <span className="font-medium text-ink">Next day</span> to move the clock and watch each case play out. Every
          customer and payment is invented. There is no sign-in or database yet, so all three roles share this page.
        </p>

        <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {counts.map((s) => (
            <div key={s.label} className="rounded-lg border border-line bg-white px-3 py-2">
              <dt className="text-xs text-muted">{s.label}</dt>
              <dd className="text-xl font-semibold text-navy">{s.value}</dd>
            </div>
          ))}
        </dl>

        {notice && (
          <p role="alert" className="mb-4 rounded-lg border border-failed/30 bg-failed-soft px-3 py-2 text-sm text-failed">
            {notice}
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <aside className="self-start rounded-lg border border-line bg-white">
            <h2 className="border-b border-line px-3 py-2.5 text-sm font-semibold text-navy">
              {role === "lender" ? "Collections queue" : role === "insurer" ? "Renewals" : "All cases"}
            </h2>
            <ul>
              {visible.map((c) => {
                const chip = caseChip(c, sims[c.id], approvedFixes);
                const active = current?.id === c.id;
                return (
                  <li key={c.id} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      onClick={() => {
                        setSelected((prev) => ({ ...prev, [role]: c.id }));
                        setNotice(null);
                      }}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left ${
                        active ? "bg-info-soft/50" : "hover:bg-canvas"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{c.merchant.customer}</span>
                        <span className="block text-xs text-muted">
                          {c.id} · {formatRupees(c.merchant.amountPaise)}
                          {role === "ops" && ` · ${c.merchant.merchantType}`}
                        </span>
                      </span>
                      <Chip tone={chip.tone}>{chip.label}</Chip>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <div className="min-w-0">
            {current && (
              <CaseDetail
                c={current}
                sim={sims[current.id]}
                day={day}
                role={role}
                approvedFixes={approvedFixes}
                onPick={(label) => onPick(current, label)}
                onPaidOutside={() => onPaidOutside(current)}
                onUseOriginal={() => onUseOriginal(current)}
                onApproveFix={(fix: FixType) => setApprovedFixes((prev) => ({ ...prev, [`${current.id}:${fix}`]: true }))}
              />
            )}
          </div>
        </div>
      </main>

      <footer className="border-t border-line bg-white">
        <p className="mx-auto w-full max-w-7xl px-4 py-3 text-xs text-muted">
          Advice only. The layer never moves money: it suggests when to retry, and the merchant decides. Any failed check
          falls back to Razorpay&apos;s original retries. Merchants are never shown a score, a percentage or anything
          about a customer&apos;s income.
        </p>
      </footer>
    </div>
  );
}

function summarize(visible: PreparedCase[], sims: Sims, approvedFixes: Record<string, boolean>) {
  const tones: Record<Tone, number> = { paid: 0, waiting: 0, info: 0, idle: 0, failed: 0 };
  let awaiting = 0;
  let failedRetries = 0;
  for (const c of visible) {
    const sim = sims[c.id];
    tones[caseChip(c, sim, approvedFixes).tone] += 1;
    if (sim?.state === "awaiting_choice") awaiting += 1;
    failedRetries += sim?.failedAttempts ?? 0;
  }
  return [
    { label: "Awaiting choice", value: awaiting },
    { label: "In progress", value: tones.info + tones.waiting - awaiting },
    { label: "Paid", value: tones.paid },
    { label: "On original retries", value: tones.idle },
    { label: "Failed retries so far", value: failedRetries },
  ];
}
