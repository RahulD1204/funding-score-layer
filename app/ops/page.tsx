// Ops console (specs/02 screen 8): the demo clock, Reset demo, the event injector, every case,
// and the Ops assistant box (connected in build step 8). Ops only.

import Link from "next/link";
import { Suspense } from "react";
import ActionButton from "@/components/actions/ActionButton";
import EventInjector, { type InjectorPreset } from "@/components/ops/EventInjector";
import { PageLoading } from "@/components/shell/AppShell";
import { Button, Chip, Panel } from "@/components/ui";
import { DEMO_CASES } from "@/lib/demo/cases";
import { FAILURE_WORDS, STATE_WORDS, failOpenWords } from "@/lib/demo/words";
import { CATCH_ALL_REASONS, CLEAR_REASONS, formatDate, type CaseState } from "@/lib/engine";
import { listCases, listObligations, opsToday } from "@/lib/data/ops";
import { requireViewer } from "@/lib/data/session";

const REASON_CODES = [
  ...Object.entries(CLEAR_REASONS).map(([code, label]) => ({ code, meaning: FAILURE_WORDS[label] ?? label })),
  ...CATCH_ALL_REASONS.map((code) => ({ code, meaning: "catch-all" })),
];

// The seeded cases 2 to 10 (specs/05), with the reason code and bank text the simulated bank returns.
const PRESETS: InjectorPreset[] = DEMO_CASES.map((c, i) => ({
  name: `Case ${i + 2} · ${c.id}`,
  obligationId: c.id,
  dueDate: c.input.dueDate,
  reasonCode: c.input.errorReason,
  bankText: c.bankText,
}));

const ROUTE_WORDS: Record<string, string> = {
  schedules: "Schedules",
  out_of_reach: "Out of reach: link",
  exceptions_desk: "Exceptions desk",
  fail_open: "Fail open",
  needs_agent: "Needs agent",
};

async function Console() {
  await requireViewer(["ops"]);
  const [today, obligations, cases] = await Promise.all([opsToday(), listObligations(), listCases()]);
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Demo clock" aside={<span className="text-xs text-muted">Every date in the demo reads this clock, never the real date</span>}>
        <div className="flex flex-wrap items-center gap-4">
          <p className="text-2xl font-semibold text-navy">
            {formatDate(today)} {today.slice(0, 4)}
          </p>
          <ActionButton route="advance-day" body={{}} pendingLabel="Moving the clock…">
            Next day
          </ActionButton>
          <ActionButton
            route="reset-demo"
            body={{}}
            variant="secondary"
            confirm="Reset the demo? Every case, event and audit row is cleared, and settings, consents and the clock go back to the seeded state."
            pendingLabel="Resetting…"
          >
            Reset demo
          </ActionButton>
        </div>
        <p className="mt-2 text-sm text-muted">
          Next day runs every open case one day forward: defaults apply, dates lock, the bank answers, and due attempts run.
        </p>
      </Panel>

      <Panel title="Event injector" aside={<span className="text-xs text-muted">Stands in for Razorpay&apos;s failed-debit webhook</span>}>
        <EventInjector
          obligations={obligations.map((o) => ({
            id: o.id,
            label: o.customers.label,
            merchant: o.merchants.name,
            kind: o.kind,
            dueDay: o.due_day,
            resultDelayDays: o.products.result_delay_days,
          }))}
          presets={PRESETS}
          reasonCodes={REASON_CODES}
          today={today}
        />
      </Panel>

      <Panel title={`Cases (${cases.length})`}>
        {cases.length === 0 ? (
          <p className="text-sm text-muted">No cases yet. Simulate a failed debit above.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {cases.map((c) => {
              const state = c.state ? STATE_WORDS[c.state as CaseState] : null;
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 text-sm">
                    <Link href={`/ops/cases/${encodeURIComponent(c.id)}`} className="font-medium text-action hover:underline">
                      {c.obligations.customers.label}
                    </Link>
                    <span className="text-muted">
                      {" "}
                      · {c.id} · {c.obligations.merchants.name} · {ROUTE_WORDS[c.route] ?? c.route}
                      {c.fail_open_reason && ` · ${failOpenWords(c.fail_open_reason)}`}
                    </span>
                  </span>
                  {state && <Chip tone={state.tone}>{state.label}</Chip>}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Ops assistant" aside={<Chip tone="idle">Connected in build step 8</Chip>}>
        <p className="mb-2 text-sm text-muted">Ask why a case went the way it did. Answers come from the audit log and cite the rows used.</p>
        <div className="flex flex-wrap gap-2">
          <input
            disabled
            placeholder="Why did L-1041 retry on 8 April?"
            aria-label="Question for the Ops assistant"
            className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm"
          />
          <Button disabled>Ask</Button>
        </div>
      </Panel>
    </div>
  );
}

export default function OpsConsolePage() {
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold text-navy">Ops console</h1>
      <Suspense fallback={<PageLoading />}>
        <Console />
      </Suspense>
    </>
  );
}
