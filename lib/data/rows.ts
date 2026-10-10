// Row shapes the screens read, as PostgREST returns them. Merchant-readable tables first.
// Types only: no queries here, so client components can import them too.

import type { ActionKind, Band, CaseState, FixMode, FixType, ScheduleLabel } from "@/lib/engine";

export interface MerchantCaseRow {
  case_id: string;
  merchant_id: string;
  customer_label: string;
  kind: "EMI" | "premium";
  amount_paise: number;
  due_date: string;
  failure_words: string | null;
  state: CaseState;
  retries_used: number;
  retries_allowed: number;
  chosen_schedule: ScheduleLabel | null;
  chosen_by: "merchant" | "default" | null;
  next_date: string | null;
  next_action_kind: ActionKind | null;
  result_due_date: string | null;
  paid_date: string | null;
  paid_via: "debit" | "link" | "outside" | null;
  public_reason: string | null;
  /** The latest customer message, its simulated date, and whether it is template text or polished wording. */
  customer_message: string | null;
  customer_message_date: string | null;
  customer_message_source: "template" | "polished" | null;
  updated_at: string;
}

export interface ScheduleOptionRow {
  case_id: string;
  merchant_id: string;
  label: ScheduleLabel;
  merged_labels: ScheduleLabel[];
  attempt_days: number[];
  main_day: number;
  band: Band;
  attempts: number;
  days_overdue: number;
  waiting_charge_paise: number | null;
  days_later_than_original: number | null;
  extra_charge_paise: number | null;
  chosen: boolean;
}

export interface DeskItemRow {
  id: number;
  merchant_id: string;
  case_id: string;
  trigger: string;
  fix_type: FixType;
  reason: string;
  mode: FixMode;
  status: "proposed" | "approved" | "done" | "rejected";
  deadline: string | null;
  created_at: string;
  merchant_cases: Pick<MerchantCaseRow, "customer_label" | "kind" | "amount_paise" | "due_date" | "failure_words" | "state"> | null;
}

export interface MerchantRow {
  id: string;
  name: string;
  type: "lender" | "insurer";
  layer_enabled: boolean;
  kill_switch: boolean;
  polish_on: boolean;
  consent_date: string | null;
}

export interface ProductRow {
  id: string;
  merchant_id: string;
  name: string;
  segment: "lending" | "insurance";
  rail: "bank_mandate" | "upi_autopay";
  last_allowed_day: number;
  max_representations: number;
  standing_default: ScheduleLabel;
  result_delay_days: number;
  penal_charge_per_day_paise: number | null;
  bounce_charge_paise: number | null;
  baseline_retry_days: number[];
  grace_days: number | null;
}

export interface FixSettingRow {
  fix_type: FixType;
  mode: FixMode;
}
