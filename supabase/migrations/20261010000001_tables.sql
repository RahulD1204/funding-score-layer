-- The 26 tables of specs/04-data-model.md, in three access groups.
-- Each table's comment starts with its group: "merchant-readable", "internal" or "system".
-- The access rules (next migration) and the access tests both read that grouping.
--
-- Amounts are whole paise (bigint). Dates are plain dates. "Day" columns count days after the due date.
-- Lists of days are integer arrays. Likelihoods, snapshots and free-form evidence are jsonb.
-- No table has a demographic or location column. Merchant tables never hold a score, a percentage,
-- confidence, tier, the predicted funded day, salary, employer or archetype. A band is allowed.
--
-- Tables are created in dependency order, so the groups are interleaved below.

-- ---------------------------------------------------------------------------
-- Merchants and their products
-- ---------------------------------------------------------------------------

create table public.merchants (
  id text primary key,
  name text not null,
  type text not null check (type in ('lender', 'insurer')),
  layer_enabled boolean not null default true,
  kill_switch boolean not null default false,
  polish_on boolean not null default false,
  consent_date date
);
comment on table public.merchants is 'merchant-readable: merchant settings and consent';

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('lender', 'insurer', 'ops')),
  merchant_id text references public.merchants (id),
  created_at timestamptz not null default now(),
  -- Ops belongs to no merchant; every lender or insurer user belongs to exactly one.
  constraint profiles_merchant_matches_role check ((role = 'ops') = (merchant_id is null))
);
comment on table public.profiles is 'merchant-readable: who is logged in and which merchant they belong to. Never writable by the user';

create table public.products (
  id text primary key,
  merchant_id text not null references public.merchants (id),
  name text not null,
  segment text not null check (segment in ('lending', 'insurance')),
  rail text not null check (rail in ('bank_mandate', 'upi_autopay')),
  last_allowed_day integer not null check (last_allowed_day >= 0),
  max_representations integer not null check (max_representations >= 0),
  standing_default text not null check (standing_default in ('Earliest', 'Balanced', 'Safest')),
  result_delay_days integer not null check (result_delay_days >= 0),
  penal_charge_per_day_paise bigint check (penal_charge_per_day_paise >= 0),
  bounce_charge_paise bigint check (bounce_charge_paise >= 0),
  baseline_retry_days integer[] not null,
  grace_days integer check (grace_days >= 0)
);
comment on table public.products is 'merchant-readable: limits, defaults and disclosed charges per product';
create index products_merchant_id_idx on public.products (merchant_id);

create table public.fix_settings (
  merchant_id text not null references public.merchants (id),
  fix_type text not null check (fix_type in (
    'stop_attempts', 'send_reregistration_link', 'hold_attempts', 'send_resume_request',
    'send_method_change_link', 'hold_and_represent', 'cancel_pending_attempt'
  )),
  mode text not null check (mode in ('automatic', 'needs_approval')),
  primary key (merchant_id, fix_type)
);
comment on table public.fix_settings is 'merchant-readable: the per-fix switch';

-- ---------------------------------------------------------------------------
-- Customers, obligations and their history
-- ---------------------------------------------------------------------------

create table public.customers (
  id text primary key,
  label text not null,
  holdout boolean not null default false,
  archetype text
);
comment on table public.customers is 'internal: stand-in for Razorpay''s unique customer id';

create table public.obligations (
  id text primary key,
  merchant_id text not null references public.merchants (id),
  product_id text not null references public.products (id),
  customer_id text not null references public.customers (id),
  kind text not null check (kind in ('EMI', 'premium')),
  amount_paise bigint not null check (amount_paise > 0),
  due_day integer not null check (due_day between 1 and 31),
  mandate_status text not null check (mandate_status in ('active', 'cancelled', 'paused', 'expired', 'unknown')),
  status text not null,
  bank text
);
comment on table public.obligations is 'internal: the recurring debit';
create index obligations_customer_id_idx on public.obligations (customer_id);
create index obligations_merchant_id_idx on public.obligations (merchant_id);

create table public.consents (
  id bigint generated always as identity primary key,
  -- Empty for the merchant's own consent row.
  customer_id text references public.customers (id),
  merchant_id text not null references public.merchants (id),
  party text not null check (party in ('merchant', 'customer')),
  purpose text not null,
  status text not null check (status in ('granted', 'withdrawn')),
  granted_date date,
  withdrawn_date date
);
comment on table public.consents is 'internal: consent records';
create index consents_customer_id_idx on public.consents (customer_id);

create table public.transactions (
  id text primary key,
  customer_id text not null references public.customers (id),
  -- Empty for everyday shops.
  merchant_id text references public.merchants (id),
  date date not null,
  amount_paise bigint not null check (amount_paise >= 0),
  direction text not null check (direction in ('credit', 'debit')),
  kind text not null,
  own_merchant boolean not null default false,
  status text not null check (status in ('success', 'failed')),
  reason_code text,
  bank_text text,
  -- The source id of a credit.
  source text,
  obligation_id text references public.obligations (id),
  cycle_due_date date,
  attempt_day integer
);
comment on table public.transactions is 'internal: every synthetic transaction the customer makes through Razorpay';
create index transactions_customer_date_idx on public.transactions (customer_id, date);
create index transactions_obligation_id_idx on public.transactions (obligation_id);

create table public.bank_downtimes (
  id bigint generated always as identity primary key,
  bank text not null,
  from_date date not null,
  to_date date not null,
  check (to_date >= from_date)
);
comment on table public.bank_downtimes is 'internal: bank downtime lookup for triage';
create index bank_downtimes_bank_idx on public.bank_downtimes (bank, from_date);

create table public.customer_signals (
  customer_id text not null references public.customers (id),
  as_of_date date not null,
  obligation_id text not null references public.obligations (id),
  timing_observations integer not null,
  months_covered integer not null,
  affordability_observations integer not null,
  has_failure_evidence boolean not null,
  identity_linked boolean not null,
  anchor_kind text check (anchor_kind in ('start', 'end')),
  anchor_value integer,
  spread numeric,
  confidence integer,
  tier text,
  salary_recognized boolean not null default false,
  likelihood_by_day jsonb,
  primary key (customer_id, as_of_date, obligation_id)
);
comment on table public.customer_signals is 'internal: the signal store';

create table public.predictions (
  id bigint generated always as identity primary key,
  obligation_id text not null references public.obligations (id),
  cycle_due_date date not null,
  source text not null check (source in ('rule', 'model')),
  h integer,
  u integer,
  likelihood_by_day jsonb,
  confidence integer,
  model_version text not null,
  unique (obligation_id, cycle_due_date, source)
);
comment on table public.predictions is 'internal: stored scores. Every prediction stores its model version';

-- ---------------------------------------------------------------------------
-- Events, cases and what happens to them
-- ---------------------------------------------------------------------------

create table public.debit_events (
  event_id text primary key,
  event_type text not null,
  obligation_id text references public.obligations (id),
  cycle_due_date date,
  reason_code text,
  bank_text text,
  clock_date date not null,
  raw_payload jsonb,
  processed boolean not null default false,
  received_at timestamptz not null default now()
);
comment on table public.debit_events is 'internal: event intake. The unique event id drops repeats';

create table public.triage_results (
  event_id text primary key references public.debit_events (event_id),
  label text not null,
  decided_by text not null check (decided_by in ('rule', 'lookup', 'agent')),
  evidence jsonb,
  agent_strength text
);
comment on table public.triage_results is 'internal: triage output';

create table public.cases (
  id text primary key,
  obligation_id text not null references public.obligations (id),
  cycle_due_date date not null,
  route text not null check (route in ('schedules', 'out_of_reach', 'exceptions_desk', 'fail_open', 'needs_agent')),
  state text check (state in (
    'awaiting_choice', 'scheduled', 'result_pending', 'link_sent', 'paid', 'failed', 'normal_retries', 'needs_action'
  )),
  fail_open_reason text,
  prediction_id bigint references public.predictions (id),
  policy_version text not null,
  limits_snapshot jsonb,
  standing_default text check (standing_default in ('Earliest', 'Balanced', 'Safest')),
  -- The engine's SimCase, stored whole.
  sim_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One case per failed cycle.
  unique (obligation_id, cycle_due_date)
);
comment on table public.cases is 'internal: one case per failed cycle. Every case stores its policy version';

create table public.plan_actions (
  case_id text not null references public.cases (id),
  action_number integer not null,
  kind text not null check (kind in ('probe', 'attempt', 'backup', 'link')),
  day integer not null,
  status text not null check (status in (
    'planned', 'locked', 'in_flight', 'succeeded', 'failed', 'sent', 'cancelled', 'dropped'
  )),
  result_due_day integer,
  executed_date date,
  primary key (case_id, action_number)
);
comment on table public.plan_actions is 'internal: attempts and links. A cancelled action keeps its row';

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  clock_date date not null,
  actor text not null,
  case_id text references public.cases (id),
  decision text not null,
  internal_reason text,
  public_reason text,
  inputs jsonb,
  policy_version text not null,
  model_version text
);
comment on table public.audit_log is 'internal: every decision. Append-only';
create index audit_log_case_id_idx on public.audit_log (case_id);

create table public.messages (
  id bigint generated always as identity primary key,
  case_id text not null references public.cases (id),
  audience text not null,
  channel text not null,
  body text not null,
  source text not null check (source in ('template', 'polished')),
  template_version text not null,
  facts jsonb,
  created_at timestamptz not null default now()
);
comment on table public.messages is 'internal: customer text';
create index messages_case_id_idx on public.messages (case_id);

create table public.model_card (
  model_version text primary key,
  policy_version text not null,
  training_period text,
  tune_period text,
  test_period text,
  day_error_baseline numeric,
  day_error_quantile numeric,
  day_error_aft numeric,
  day_error_chosen numeric,
  coverage_80 jsonb,
  band_calibration jsonb,
  eligible_share jsonb,
  chosen_model text,
  failed_per_collected jsonb,
  salary_recognition jsonb,
  catch_all jsonb,
  seed integer,
  data text
);
comment on table public.model_card is 'internal: model evidence for the ops screen';

-- ---------------------------------------------------------------------------
-- What a merchant reads. Plain tables written only by server functions, never views.
-- ---------------------------------------------------------------------------

create table public.merchant_cases (
  case_id text primary key references public.cases (id),
  merchant_id text not null references public.merchants (id),
  customer_label text not null,
  kind text not null check (kind in ('EMI', 'premium')),
  amount_paise bigint not null check (amount_paise > 0),
  due_date date not null,
  failure_words text,
  state text not null check (state in (
    'awaiting_choice', 'scheduled', 'result_pending', 'link_sent', 'paid', 'failed', 'normal_retries', 'needs_action'
  )),
  retries_used integer not null default 0,
  retries_allowed integer not null,
  chosen_schedule text check (chosen_schedule in ('Earliest', 'Balanced', 'Safest')),
  chosen_by text check (chosen_by in ('merchant', 'default')),
  -- For an insurer, written only once the action locks (merchantView in lib/engine/simulate.ts).
  next_date date,
  next_action_kind text check (next_action_kind in ('probe', 'attempt', 'backup', 'link')),
  result_due_date date,
  paid_date date,
  paid_via text check (paid_via in ('debit', 'link', 'outside')),
  public_reason text,
  updated_at timestamptz not null default now(),
  -- Lets schedule_options and desk_items prove they belong to the same merchant as their case.
  unique (case_id, merchant_id)
);
comment on table public.merchant_cases is 'merchant-readable: the only case data a merchant reads. Mirrors merchantView';
create index merchant_cases_merchant_id_idx on public.merchant_cases (merchant_id);

create table public.schedule_options (
  case_id text not null,
  -- Not in the spec's key columns: carried so the access rule can check the merchant directly.
  merchant_id text not null references public.merchants (id),
  label text not null check (label in ('Earliest', 'Balanced', 'Safest')),
  merged_labels text[] not null,
  attempt_days integer[] not null,
  main_day integer not null,
  band text not null check (band in ('High', 'Medium', 'Lower')),
  attempts integer not null,
  days_overdue integer not null,
  waiting_charge_paise bigint,
  days_later_than_original integer,
  extra_charge_paise bigint,
  chosen boolean not null default false,
  primary key (case_id, label),
  foreign key (case_id, merchant_id) references public.merchant_cases (case_id, merchant_id)
);
comment on table public.schedule_options is 'merchant-readable: the schedule cards, for lenders only. Mirrors ScheduleCard';
create index schedule_options_merchant_id_idx on public.schedule_options (merchant_id);

create table public.desk_items (
  id bigint generated always as identity primary key,
  merchant_id text not null references public.merchants (id),
  case_id text not null,
  trigger text not null check (trigger in (
    'mandate_cancelled', 'mandate_paused', 'instrument_closed', 'bank_downtime', 'customer_paid'
  )),
  fix_type text not null check (fix_type in (
    'stop_attempts', 'send_reregistration_link', 'hold_attempts', 'send_resume_request',
    'send_method_change_link', 'hold_and_represent', 'cancel_pending_attempt'
  )),
  reason text not null,
  mode text not null check (mode in ('automatic', 'needs_approval')),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'done', 'rejected')),
  decided_by uuid references auth.users (id),
  deadline date,
  created_at timestamptz not null default now(),
  foreign key (case_id, merchant_id) references public.merchant_cases (case_id, merchant_id)
);
comment on table public.desk_items is 'merchant-readable: the exceptions desk queue';
create index desk_items_merchant_id_idx on public.desk_items (merchant_id);

-- ---------------------------------------------------------------------------
-- System
-- ---------------------------------------------------------------------------

create table public.sim_clock (
  -- Always true: the table holds exactly one row.
  id boolean primary key default true check (id),
  today date not null
);
comment on table public.sim_clock is 'system: the simulated date. One row';

create table public.sim_truth (
  customer_id text not null references public.customers (id),
  obligation_id text not null references public.obligations (id),
  cycle_due_date date not null,
  -- Empty when the customer is never funded in this cycle.
  funded_on_day integer,
  true_cause text,
  reason_code text,
  bank_text text,
  primary key (obligation_id, cycle_due_date)
);
comment on table public.sim_truth is 'system: ground truth. Read only by advance-day and the tests';

create table public.prompts (
  name text not null,
  version text not null,
  text text not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (name, version)
);
comment on table public.prompts is 'system: agent prompts and message templates';
create unique index prompts_one_active_idx on public.prompts (name) where active;

create table public.llm_runs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid references auth.users (id),
  purpose text not null,
  agent text,
  prompt_version text,
  model text,
  tools_called jsonb,
  steps integer check (steps between 0 and 4),
  input_fields jsonb,
  output jsonb,
  validation_result jsonb,
  tokens jsonb,
  duration_ms integer,
  status text not null
);
comment on table public.llm_runs is 'system: every model call and agent step, with what the rules did with the answer';

create table public.usage (
  user_id uuid not null references auth.users (id),
  date date not null,
  agent_runs integer not null default 0 check (agent_runs >= 0),
  primary key (user_id, date)
);
comment on table public.usage is 'system: agent runs per user per day';
