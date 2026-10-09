"use client";

// The pick button on a schedule card. It calls choose-schedule; the server decides with the
// engine's pickSchedule and refuses a late pick, whatever this screen showed.

import { formatDate } from "@/lib/engine";
import ActionButton from "@/components/actions/ActionButton";

export default function PickControls({
  caseId,
  label,
  open,
  lastDay,
  chosen,
}: {
  caseId: string;
  label: string;
  open: boolean;
  lastDay: string;
  chosen: boolean;
}) {
  return (
    <>
      <span className="text-xs text-muted">
        {open ? `Pick by ${formatDate(lastDay)}` : chosen ? "Locked in" : "Too close to pick"}
      </span>
      <ActionButton route="choose-schedule" body={{ caseId, label }} disabled={!open || chosen} pendingLabel="Saving…">
        {chosen ? "Picked" : "Use this schedule"}
      </ActionButton>
    </>
  );
}
