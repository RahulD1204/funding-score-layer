"use client";

// The editable parts of Settings (specs/02 screen 6). Every change goes through update-controls,
// which checks the role and the merchant, and audits it. New limits apply to cases opened afterwards.

import { useState } from "react";
import { Button } from "@/components/ui";
import { useApi } from "@/components/actions/api";

const SCHEDULES = ["Earliest", "Balanced", "Safest"] as const;

export function ProductLimitsForm({
  productId,
  lastAllowedDay,
  maxRepresentations,
  standingDefault,
  lending,
}: {
  productId: string;
  lastAllowedDay: number;
  maxRepresentations: number;
  standingDefault: string;
  lending: boolean;
}) {
  const { run, pending, error } = useApi();
  const [cap, setCap] = useState(String(lastAllowedDay));
  const [reps, setReps] = useState(String(maxRepresentations));
  const [label, setLabel] = useState(standingDefault);
  const [saved, setSaved] = useState(false);
  const changed = cap !== String(lastAllowedDay) || reps !== String(maxRepresentations) || label !== standingDefault;

  async function save() {
    setSaved(false);
    if (cap !== String(lastAllowedDay) || reps !== String(maxRepresentations)) {
      const answer = await run("update-controls", {
        action: "set_limits",
        productId,
        lastAllowedDay: Number(cap),
        maxRepresentations: Number(reps),
      });
      if (!answer.ok) return;
    }
    if (label !== standingDefault) {
      const answer = await run("update-controls", { action: "set_standing_default", productId, label });
      if (!answer.ok) return;
    }
    setSaved(true);
  }

  const field = "w-24 rounded-lg border border-line bg-white px-2 py-1.5 text-sm";
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{lending ? "Your overdue cap (days after the due date)" : "Last day an attempt may run (days after the due date)"}</span>
          <input type="number" min={0} max={30} value={cap} onChange={(e) => setCap(e.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{lending ? "Maximum re-presentations" : "Maximum attempts"}</span>
          <input type="number" min={0} max={30} value={reps} onChange={(e) => setReps(e.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Standing default</span>
          <select value={label} onChange={(e) => setLabel(e.target.value)} className="w-36 rounded-lg border border-line bg-white px-2 py-1.5 text-sm">
            {SCHEDULES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={!changed || pending}>
          {pending ? "Saving…" : "Save limits"}
        </Button>
        {saved && !error && <span className="text-sm text-paid">Saved. New cases use these limits; open cases keep theirs.</span>}
        {error && (
          <span role="alert" className="text-sm text-failed">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

export function FixModeSelect({ fixType, mode, label }: { fixType: string; mode: string; label: string }) {
  const { run, pending, error } = useApi();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <select
        aria-label={`Mode for: ${label}`}
        value={mode}
        disabled={pending}
        onChange={(e) => void run("update-controls", { action: "set_fix_mode", fixType, mode: e.target.value })}
        className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
      >
        <option value="automatic">Automatic</option>
        <option value="needs_approval">Needs approval</option>
      </select>
      {error && (
        <span role="alert" className="text-xs text-failed">
          {error}
        </span>
      )}
    </span>
  );
}
