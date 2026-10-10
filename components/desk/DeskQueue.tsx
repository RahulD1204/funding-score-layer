"use client";

// The exceptions desk queue with its approve buttons (specs/02 screen 5). A fix that waits for
// approval can be ticked; "Approve selected" and "Approve all" call approve-fixes, which runs the
// fixes and audits them. The page passes rows already worked out from merchant tables.

import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/components/actions/api";
import { Button, Chip } from "@/components/ui";

export interface DeskQueueRow {
  id: number;
  caseHref: string;
  customer: string;
  summary: string;
  fix: string;
  /** Shown only when it says more than the fix's own description. */
  reason: string | null;
  mode: "automatic" | "needs_approval";
  deadline: string | null;
  status: { label: string; tone: "waiting" | "info" | "paid" | "idle" };
  /** Proposed and needs approval: the merchant can approve it. */
  waiting: boolean;
}

export default function DeskQueue({ rows }: { rows: DeskQueueRow[] }) {
  const { run, pending, error } = useApi();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const waiting = rows.filter((r) => r.waiting);
  const chosen = waiting.filter((r) => selected.has(r.id)).map((r) => r.id);

  function toggle(id: number) {
    setSelected((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function approve(body: Record<string, unknown>, count: number) {
    const words = count === 1 ? "this fix" : `these ${count} fixes`;
    if (!window.confirm(`Approve and run ${words}? Each one is recorded in the audit log.`)) return;
    const answer = await run("approve-fixes", body);
    if (answer.ok) setSelected(new Set());
  }

  return (
    <>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line bg-white px-3 py-3">
            <div className="flex min-w-0 items-start gap-3">
              <input
                type="checkbox"
                disabled={!row.waiting || pending}
                checked={row.waiting && selected.has(row.id)}
                onChange={() => toggle(row.id)}
                aria-label={`Select: ${row.fix} for ${row.customer}`}
                className="mt-1"
              />
              <div className="min-w-0">
                <p className="text-sm">
                  <Link href={row.caseHref} className="font-medium text-action hover:underline">
                    {row.customer}
                  </Link>
                  <span className="text-muted"> · {row.summary}</span>
                </p>
                <p className="mt-1 text-sm font-medium">{row.fix}</p>
                {row.reason && <p className="text-sm text-muted">{row.reason}</p>}
                <p className="mt-1 text-xs text-muted">
                  {row.mode === "automatic" ? "Automatic: runs by itself." : "Needs approval: contacts the customer."}
                  {row.deadline && ` Deadline ${row.deadline}.`}
                </p>
              </div>
            </div>
            <Chip tone={row.status.tone}>{row.status.label}</Chip>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button disabled={pending || chosen.length === 0} onClick={() => void approve({ itemIds: chosen }, chosen.length)}>
          {pending ? "Running…" : `Approve selected${chosen.length ? ` (${chosen.length})` : ""}`}
        </Button>
        <Button variant="secondary" disabled={pending || waiting.length === 0} onClick={() => void approve({ all: true }, waiting.length)}>
          Approve all ({waiting.length})
        </Button>
        <span className="text-xs text-muted">Prototype: an approved fix is recorded, and nothing is sent to the customer yet.</span>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-failed">
          {error}
        </p>
      )}
    </>
  );
}
