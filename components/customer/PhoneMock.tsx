"use client";

// The customer phone mock (specs/02 screen 7): the consent notice, the dated message, the
// pay-by-link button and withdraw consent. No login: the signed case link is the only key, and
// the server returns only this case's listed fields.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { callApi } from "@/components/actions/api";
import { formatDate, formatRupees } from "@/lib/engine";
import type { CustomerCaseView } from "@/lib/server/flows/customer-case";

export default function PhoneMock({ token }: { token: string }) {
  const [view, setView] = useState<CustomerCaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const answer = await callApi("customer-case", { customerToken: token });
    if (answer.ok) setView(answer.data as unknown as CustomerCaseView);
    else setError(answer.message);
  }, [token]);

  useEffect(() => {
    // Loads the case once the page opens; the answer arrives from the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function act(action: "pay_by_link" | "withdraw_consent", confirmText: string) {
    if (!view || !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    const answer = await callApi("update-controls", { action, caseId: view.caseId, customerToken: token });
    if (!answer.ok) setError(answer.message);
    await load();
    setBusy(false);
  }

  return (
    <div className="mx-auto w-full max-w-sm rounded-[2rem] border-8 border-navy bg-white shadow-lg">
      <div className="flex items-center justify-between rounded-t-[1.5rem] bg-navy px-4 py-2 text-xs text-white">
        <span>Messages</span>
        <span>Demo phone</span>
      </div>
      <div className="flex min-h-[28rem] flex-col gap-3 px-4 py-4">
        {!view && !error && <p className="text-sm text-muted">Loading…</p>}
        {error && (
          <p role="alert" className="rounded-lg border border-failed/30 bg-failed-soft px-3 py-2 text-sm text-failed">
            {error}
          </p>
        )}
        {view && (
          <>
            <p className="text-xs text-muted">
              To {view.customer}, from {view.merchant}
            </p>
            <div className="rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-muted">
              <span className="font-medium text-ink">Consent notice.</span> {view.merchant} uses the timing of your past payments
              through Razorpay to choose a better day to try your {view.kind} again. It never changes your due date and never
              uses your income. You can withdraw this at any time.{" "}
              <span className="font-medium">{view.consent === "granted" ? "Status: given." : "Status: withdrawn."}</span>
            </div>

            {view.message ? (
              <div className="self-start rounded-2xl rounded-bl-sm bg-info-soft px-3 py-2 text-sm">{view.message}</div>
            ) : view.status === "paid" ? null : (
              <p className="text-sm text-muted">No message yet. One arrives the day before the next attempt.</p>
            )}

            {view.status === "paid" && view.paidDate && (
              <div className="self-start rounded-2xl rounded-bl-sm bg-paid-soft px-3 py-2 text-sm text-paid">
                Your {view.kind} of {formatRupees(view.amountPaise)} due on {formatDate(view.dueDate)} is paid. Received on{" "}
                {formatDate(view.paidDate)}.
              </div>
            )}

            <div className="mt-auto flex flex-col gap-2">
              {view.status === "link" && (
                <Button
                  disabled={busy}
                  onClick={() => void act("pay_by_link", `Pay ${formatRupees(view.amountPaise)} to ${view.merchant}? This is a demo: no money moves.`)}
                >
                  Pay {formatRupees(view.amountPaise)} by link
                </Button>
              )}
              {view.consent === "granted" && view.status !== "paid" && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act("withdraw_consent", "Withdraw consent? The usual retries from Razorpay apply from now on.")
                  }
                >
                  Withdraw consent
                </Button>
              )}
              <p className="text-center text-xs text-muted">Synthetic demo. No real message is sent and no money moves.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
