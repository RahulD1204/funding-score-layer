// Engine 7: merchant choice and execution, as a pure state machine.
// The server functions (choose-schedule, advance-day, update-controls) wrap these same
// functions and add storage, so the flow rules are tested here without a database.
//
// Days are counted from the due date. `today` is the simulated clock, never the real date.

import type { MerchantType, ScheduleLabel } from "./policy";
import { resolveOption, type ScheduleBuild, type ScheduleOption } from "./schedule";

export type CaseState =
  | "awaiting_choice"
  | "scheduled"
  | "result_pending"
  | "link_sent"
  | "paid"
  | "failed"
  | "normal_retries"
  | "needs_action";

export type ActionKind = "probe" | "attempt" | "backup" | "link";
export type ActionStatus =
  | "planned"
  | "locked"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "sent"
  | "cancelled"
  | "dropped";

export interface SimAction {
  id: number;
  kind: ActionKind;
  day: number;
  status: ActionStatus;
  /** Set once a debit is presented: the day its result is known. */
  resultDueDay?: number;
  /** The true outcome, hidden until the result day. */
  hiddenSuccess?: boolean;
}

export interface SimLogEntry {
  day: number;
  event: string;
  detail?: string;
}

export interface SimCase {
  merchantType: MerchantType;
  route: "schedules" | "out_of_reach";
  resultDelayDays: number;
  lastAllowedDay: number;
  options: ScheduleOption[];
  standingDefault: ScheduleLabel;
  chosen: ScheduleLabel | null;
  chosenBy: "merchant" | "default" | null;
  state: CaseState;
  actions: SimAction[];
  today: number;
  /** Failed re-presentations after the due-date debit. */
  failedAttempts: number;
  paidDay: number | null;
  paidVia: "debit" | "link" | "outside" | null;
  stopReason: string | null;
  /** Razorpay's original retry days that resume after the layer steps back. */
  baselineRemaining: number[];
  log: SimLogEntry[];
}

/** What the clock needs to know about the world on each day. */
export interface SimWorld {
  /** The day the customer can first cover the debit. Null means never in this cycle. */
  fundedOnDay: number | null;
  /** Re-run of the control checks before an attempt. Return a failure code to stop the plan. */
  controlFailure?: (day: number) => string | null;
  /** Result delay for one action, to model a late confirmation. Keyed by action id. */
  resultDelayOverride?: Record<number, number>;
}

const clone = <T>(value: T): T => structuredClone(value);

function pending(a: SimAction): boolean {
  return a.status === "planned" || a.status === "locked";
}

function isDebit(a: SimAction): boolean {
  return a.kind !== "link";
}

function log(c: SimCase, event: string, detail?: string): void {
  c.log.push({ day: c.today, event, detail });
}

function setActionsFromOption(c: SimCase, option: ScheduleOption): void {
  c.actions = option.attempts.map((a, i) => ({ id: i + 1, kind: a.kind, day: a.day, status: "planned" as const }));
}

function lockDue(c: SimCase): void {
  for (const a of c.actions) {
    // An action locks when the clock reaches the day before its date, which leaves room for the pre-debit notice.
    if (a.status === "planned" && a.day - 1 <= c.today) a.status = "locked";
  }
}

function cancelPending(c: SimCase, status: "cancelled" | "dropped" = "cancelled"): void {
  for (const a of c.actions) if (pending(a)) a.status = status;
}

function deriveState(c: SimCase): void {
  if (c.paidDay !== null) {
    c.state = "paid";
    return;
  }
  if (c.stopReason !== null) return; // normal_retries or needs_action stays as set
  if (c.actions.some((a) => a.status === "in_flight")) c.state = "result_pending";
  else if (c.actions.some(pending)) c.state = "scheduled";
  else if (c.actions.length === 0) c.state = "awaiting_choice";
  else if (c.actions.some((a) => a.kind === "link" && a.status === "sent")) c.state = "link_sent";
  else c.state = "failed";
}

function applyOption(c: SimCase, option: ScheduleOption, by: "merchant" | "default"): void {
  c.chosen = option.label;
  c.chosenBy = by;
  setActionsFromOption(c, option);
  log(c, by === "default" ? "standing_default_applied" : "schedule_picked", option.label);
  lockDue(c);
  deriveState(c);
}

function applyDefaultIfDue(c: SimCase): void {
  if (c.state !== "awaiting_choice" || c.route !== "schedules") return;
  const option = resolveOption(c.options, c.standingDefault) ?? c.options[0];
  if (!option) return;
  // An insurer never picks, so the default applies at once.
  // For a lender it applies when its first date is about to lock and nobody has picked.
  if (c.merchantType === "insurer" || option.firstActionDay - 1 <= c.today) applyOption(c, option, "default");
}

export interface OpenCaseInput {
  merchantType: MerchantType;
  build: ScheduleBuild;
  standingDefault: ScheduleLabel;
  resultDelayDays: number;
  lastAllowedDay: number;
  /** The day the case opens. Defaults to the day the due-date failure is known. */
  today?: number;
}

/** Opens a case once triage, the checks and the gate have passed and schedules are built. */
export function openCase(input: OpenCaseInput): SimCase {
  const c: SimCase = {
    merchantType: input.merchantType,
    route: input.build.route,
    resultDelayDays: input.resultDelayDays,
    lastAllowedDay: input.lastAllowedDay,
    options: clone(input.build.options),
    standingDefault: input.standingDefault,
    chosen: null,
    chosenBy: null,
    state: "awaiting_choice",
    actions: [],
    today: input.today ?? input.build.failureKnownDay,
    failedAttempts: 0,
    paidDay: null,
    paidVia: null,
    stopReason: null,
    baselineRemaining: [],
    log: [],
  };
  log(c, "case_opened", c.route);
  if (c.route === "out_of_reach") {
    // No debit can reach payday inside the merchant's limits: a payment link is the whole plan.
    c.actions = [{ id: 1, kind: "link", day: input.build.linkDay ?? c.today + 1, status: "planned" }];
    lockDue(c);
    deriveState(c);
    return c;
  }
  applyDefaultIfDue(c);
  return c;
}

export type PickError = "not_a_lender" | "no_such_schedule" | "locked" | "case_closed";

/** A lender picks a schedule. Allowed until that schedule's first date locks, and only before anything is locked. */
export function pickSchedule(
  current: SimCase,
  label: ScheduleLabel,
): { ok: true; case: SimCase } | { ok: false; error: PickError } {
  if (current.merchantType !== "lender") return { ok: false, error: "not_a_lender" };
  if (current.route !== "schedules" || (current.state !== "awaiting_choice" && current.state !== "scheduled")) {
    return { ok: false, error: "case_closed" };
  }
  if (current.actions.some((a) => a.status !== "planned")) return { ok: false, error: "locked" };
  const option = resolveOption(current.options, label);
  if (!option) return { ok: false, error: "no_such_schedule" };
  if (option.firstActionDay - 1 <= current.today) return { ok: false, error: "locked" };
  const c = clone(current);
  applyOption(c, option, "merchant");
  return { ok: true, case: c };
}

function resolveResult(c: SimCase, a: SimAction): void {
  if (a.hiddenSuccess) {
    a.status = "succeeded";
    c.paidDay = a.day;
    c.paidVia = "debit";
    log(c, "debit_succeeded", `presented on day ${a.day}`);
    // Only one successful debit is allowed in a cycle.
    cancelPending(c);
  } else {
    a.status = "failed";
    c.failedAttempts += 1;
    log(c, "debit_failed", `presented on day ${a.day}`);
  }
}

/** Moves the clock forward one day and runs everything due. */
export function advanceDay(current: SimCase, world: SimWorld): SimCase {
  const c = clone(current);
  c.today += 1;

  // A. The standing default applies when its first date is about to lock.
  applyDefaultIfDue(c);
  // B. Lock tomorrow's actions.
  lockDue(c);

  // C. Results that are due today. These still arrive after the layer has stepped back.
  for (const a of c.actions) {
    if (a.status === "in_flight" && a.resultDueDay !== undefined && a.resultDueDay <= c.today && c.paidDay === null) {
      resolveResult(c, a);
    }
  }

  // D. A link that was sent earlier is paid once the customer is funded.
  payLinkIfFunded(c, world);

  // E. Today's actions.
  if (c.paidDay === null && c.stopReason === null) {
    const due = c.actions.filter((a) => pending(a) && a.day === c.today).sort((x, y) => x.id - y.id);
    for (const a of due) {
      if (c.paidDay !== null || c.stopReason !== null) break;

      // The control checks run again before every action.
      const failure = world.controlFailure?.(c.today) ?? null;
      if (failure) {
        cancelPending(c);
        c.stopReason = failure;
        c.state = failure === "mandate_not_active" ? "needs_action" : "normal_retries";
        log(c, "plan_stopped", failure);
        break;
      }

      if (a.kind === "link") {
        a.status = "sent";
        log(c, "link_sent");
        payLinkIfFunded(c, world);
        continue;
      }

      // Never present a debit while an earlier one is unresolved.
      const inFlight = c.actions.filter((x) => x.status === "in_flight");
      if (inFlight.length > 0) {
        const newDay = Math.max(...inFlight.map((x) => x.resultDueDay ?? c.today)) + 1;
        if (newDay <= c.lastAllowedDay) {
          a.day = newDay;
          log(c, "debit_held", `moved to day ${newDay} until the earlier result is known`);
        } else {
          a.status = "dropped";
          log(c, "debit_dropped", "the earlier result would arrive after the last allowed day");
        }
        continue;
      }

      a.hiddenSuccess = world.fundedOnDay !== null && c.today >= world.fundedOnDay;
      const delay = world.resultDelayOverride?.[a.id] ?? c.resultDelayDays;
      a.resultDueDay = c.today + delay;
      a.status = "in_flight";
      log(c, "debit_presented", a.kind);
      if (delay === 0) resolveResult(c, a);
    }
  }

  deriveState(c);
  return c;
}

function payLinkIfFunded(c: SimCase, world: SimWorld): void {
  if (c.paidDay !== null) return;
  const sent = c.actions.some((a) => a.kind === "link" && a.status === "sent");
  if (sent && world.fundedOnDay !== null && c.today >= world.fundedOnDay) {
    c.paidDay = c.today;
    c.paidVia = "link";
    log(c, "link_paid");
    cancelPending(c);
  }
}

export function advanceTo(current: SimCase, day: number, world: SimWorld): SimCase {
  let c = current;
  while (c.today < day) c = advanceDay(c, world);
  return c;
}

export type PaymentError = "attempt_in_flight" | "already_paid";

/**
 * The customer pays by link, or the merchant marks the cycle as paid outside.
 * Refused while a debit is in flight, because that debit could also succeed and collect twice.
 */
export function recordOutsidePayment(
  current: SimCase,
  via: "link" | "outside" = "outside",
): { ok: true; case: SimCase } | { ok: false; error: PaymentError } {
  if (current.paidDay !== null) return { ok: false, error: "already_paid" };
  if (current.actions.some((a) => a.status === "in_flight")) return { ok: false, error: "attempt_in_flight" };
  const c = clone(current);
  c.paidDay = c.today;
  c.paidVia = via;
  cancelPending(c);
  log(c, "paid_outside_plan", via);
  deriveState(c);
  return { ok: true, case: c };
}

/**
 * The layer steps back: kill switch, consent withdrawn, or the merchant forces normal retries.
 * Pending actions are cancelled and Razorpay's original retries resume for the days still ahead.
 */
export function stopLayer(current: SimCase, reason: string, baselineRetryDays: number[]): SimCase {
  const c = clone(current);
  if (c.paidDay !== null) return c;
  cancelPending(c);
  c.stopReason = reason;
  c.state = reason === "mandate_not_active" ? "needs_action" : "normal_retries";
  c.baselineRemaining = baselineRetryDays.filter((d) => d > c.today);
  log(c, "plan_stopped", reason);
  return c;
}

// ---------------------------------------------------------------------------
// Baseline and comparison
// ---------------------------------------------------------------------------

export interface BaselineAttempt {
  day: number;
  success: boolean;
  resultDay: number;
}

export interface BaselineOutcome {
  attempts: BaselineAttempt[];
  failedAttempts: number;
  paidDay: number | null;
  confirmedDay: number | null;
}

/** Plays Razorpay's original retries against the same truth, for the holdout and the comparison row. */
export function simulateBaseline(retryDays: number[], resultDelayDays: number, fundedOnDay: number | null): BaselineOutcome {
  const attempts: BaselineAttempt[] = [];
  let failedAttempts = 0;
  for (const day of [...retryDays].sort((a, b) => a - b)) {
    const success = fundedOnDay !== null && day >= fundedOnDay;
    attempts.push({ day, success, resultDay: day + resultDelayDays });
    if (success) return { attempts, failedAttempts, paidDay: day, confirmedDay: day + resultDelayDays };
    failedAttempts += 1;
  }
  return { attempts, failedAttempts, paidDay: null, confirmedDay: null };
}

export interface CaseOutcome {
  state: CaseState;
  failedAttempts: number;
  debitsPresented: number;
  paidDay: number | null;
  paidVia: SimCase["paidVia"];
}

export function outcomeOf(c: SimCase): CaseOutcome {
  return {
    state: c.state,
    failedAttempts: c.failedAttempts,
    debitsPresented: c.actions.filter((a) => isDebit(a) && a.resultDueDay !== undefined).length,
    paidDay: c.paidDay,
    paidVia: c.paidVia,
  };
}

// ---------------------------------------------------------------------------
// What a merchant may see
// ---------------------------------------------------------------------------

export interface MerchantCaseView {
  state: CaseState;
  /** Lenders see the next planned date at once. Insurers see it only once it has locked. */
  nextActionDay: number | null;
  nextActionKind: ActionKind | null;
  resultDueDay: number | null;
  attemptsUsed: number;
  chosen: ScheduleLabel | null;
  /** Schedule options are shown to lenders only. */
  options: ScheduleOption[] | null;
}

/** The only shape written to the merchant-facing tables. It never carries h, u, confidence or a likelihood number. */
export function merchantView(c: SimCase): MerchantCaseView {
  const next = c.actions.filter(pending).sort((a, b) => a.day - b.day)[0] ?? null;
  const visible = next !== null && (c.merchantType === "lender" || next.status === "locked");
  const inFlight = c.actions.find((a) => a.status === "in_flight");
  return {
    state: c.state,
    nextActionDay: visible ? next.day : null,
    nextActionKind: visible ? next.kind : null,
    resultDueDay: inFlight?.resultDueDay ?? null,
    attemptsUsed: c.actions.filter((a) => isDebit(a) && a.resultDueDay !== undefined).length,
    chosen: c.merchantType === "lender" ? c.chosen : null,
    options: c.merchantType === "lender" ? c.options : null,
  };
}
