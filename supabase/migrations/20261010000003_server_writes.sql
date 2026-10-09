-- Two database functions for the server functions in app/api/ (build step 6), plus the seed copy
-- that Reset demo restores from. Only the secret key (service_role) may call the public functions.
--
--   save_case_bundle(bundle)  writes one case's rows in a single transaction: all or nothing.
--                             It stores rows that lib/server built from the engine's output. No rules.
--   reset_demo(actor, ...)    puts the demo back to the seeded state. Runs as the database owner,
--                             because only the owner may empty tables (audit_log included).

-- ---------------------------------------------------------------------------
-- The seed copy. Kept in the private schema, which the API does not expose and no app user can read.
-- One row per table: the settings rows as the seed loaded them, and the seeded clock.
-- ---------------------------------------------------------------------------

create table private.seed_snapshot (
  table_name text primary key,
  rows jsonb not null,
  taken_at timestamptz not null default now()
);
comment on table private.seed_snapshot is 'Seeded settings rows that reset_demo restores. Not app data; never readable by an app user';
alter table private.seed_snapshot enable row level security;
revoke all on private.seed_snapshot from public, anon, authenticated, service_role;

-- Called by scripts/seed.ts, as the owner, after it loads the CSV files.
create function private.take_seed_snapshot() returns void
language sql set search_path = ''
as $$
  delete from private.seed_snapshot where true;
  insert into private.seed_snapshot (table_name, rows)
  select 'merchants', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.merchants t
  union all select 'products', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.products t
  union all select 'fix_settings', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.fix_settings t
  union all select 'consents', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.consents t
  union all select 'sim_clock', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.sim_clock t;
$$;
revoke execute on function private.take_seed_snapshot() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- save_case_bundle
--
-- bundle = {
--   case:                 the cases row (id, obligation_id, cycle_due_date, route, state, ...)
--   expected_updated_at:  absent for a new case. Otherwise the updated_at the caller read;
--                         if the case changed since, nothing is saved (error 40001, "case_changed").
--                         Null saves regardless: used only to fail a case open after an error.
--   merchant_case:        the merchant_cases row. failure_words and public_reason keep their
--                         stored value when sent empty.
--   schedule_options:     the card rows (lenders only; the step 5 guard refuses insurers)
--   plan_actions:         every action of the case's plan. Stored actions missing from the list are
--                         cancelled, never deleted (a re-pick can shorten the plan).
--   desk_items:           new desk rows
--   triage_result:        the triage row for the event
--   event_id:             marks that debit event processed
--   audit:                audit rows to append
-- }
-- Runs with the caller's rights (security invoker): service_role may insert and update, never delete.
-- ---------------------------------------------------------------------------

create function public.save_case_bundle(bundle jsonb) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  c public.cases;
  v_case_id text := bundle->'case'->>'id';
  saved_at timestamptz;
begin
  if v_case_id is null then
    raise exception 'save_case_bundle: the bundle has no case id' using errcode = '22023';
  end if;
  c := jsonb_populate_record(null::public.cases, bundle->'case');

  if bundle ? 'expected_updated_at' then
    update public.cases set
      route = c.route,
      state = c.state,
      fail_open_reason = c.fail_open_reason,
      sim_snapshot = c.sim_snapshot,
      updated_at = clock_timestamp()
    where id = v_case_id
      and (bundle->>'expected_updated_at' is null or updated_at = (bundle->>'expected_updated_at')::timestamptz)
    returning updated_at into saved_at;
    if saved_at is null then
      raise exception 'case_changed' using errcode = '40001', detail = v_case_id;
    end if;
  else
    insert into public.cases (id, obligation_id, cycle_due_date, route, state, fail_open_reason, prediction_id,
      policy_version, limits_snapshot, standing_default, sim_snapshot)
    values (c.id, c.obligation_id, c.cycle_due_date, c.route, c.state, c.fail_open_reason, c.prediction_id,
      c.policy_version, c.limits_snapshot, c.standing_default, c.sim_snapshot)
    returning updated_at into saved_at;
  end if;

  if bundle ? 'merchant_case' then
    insert into public.merchant_cases as m (case_id, merchant_id, customer_label, kind, amount_paise, due_date,
      failure_words, state, retries_used, retries_allowed, chosen_schedule, chosen_by, next_date, next_action_kind,
      result_due_date, paid_date, paid_via, public_reason)
    select v_case_id, r.merchant_id, r.customer_label, r.kind, r.amount_paise, r.due_date,
      r.failure_words, r.state, r.retries_used, r.retries_allowed, r.chosen_schedule, r.chosen_by, r.next_date,
      r.next_action_kind, r.result_due_date, r.paid_date, r.paid_via, r.public_reason
    from jsonb_populate_record(null::public.merchant_cases, bundle->'merchant_case') r
    on conflict on constraint merchant_cases_pkey do update set
      failure_words = coalesce(excluded.failure_words, m.failure_words),
      state = excluded.state,
      retries_used = excluded.retries_used,
      retries_allowed = excluded.retries_allowed,
      chosen_schedule = excluded.chosen_schedule,
      chosen_by = excluded.chosen_by,
      next_date = excluded.next_date,
      next_action_kind = excluded.next_action_kind,
      result_due_date = excluded.result_due_date,
      paid_date = excluded.paid_date,
      paid_via = excluded.paid_via,
      public_reason = coalesce(excluded.public_reason, m.public_reason),
      updated_at = clock_timestamp();
  end if;

  if jsonb_typeof(bundle->'schedule_options') = 'array' then
    insert into public.schedule_options as s (case_id, merchant_id, label, merged_labels, attempt_days, main_day,
      band, attempts, days_overdue, waiting_charge_paise, days_later_than_original, extra_charge_paise, chosen)
    select v_case_id, r.merchant_id, r.label, r.merged_labels, r.attempt_days, r.main_day, r.band, r.attempts,
      r.days_overdue, r.waiting_charge_paise, r.days_later_than_original, r.extra_charge_paise, coalesce(r.chosen, false)
    from jsonb_populate_recordset(null::public.schedule_options, bundle->'schedule_options') r
    on conflict on constraint schedule_options_pkey do update set chosen = excluded.chosen;
  end if;

  if jsonb_typeof(bundle->'plan_actions') = 'array' then
    insert into public.plan_actions as p (case_id, action_number, kind, day, status, result_due_day, executed_date)
    select v_case_id, r.action_number, r.kind, r.day, r.status, r.result_due_day, r.executed_date
    from jsonb_populate_recordset(null::public.plan_actions, bundle->'plan_actions') r
    on conflict on constraint plan_actions_pkey do update set
      kind = excluded.kind,
      day = excluded.day,
      status = excluded.status,
      result_due_day = excluded.result_due_day,
      executed_date = excluded.executed_date;

    update public.plan_actions p set status = 'cancelled'
    where p.case_id = v_case_id
      and p.status in ('planned', 'locked')
      and p.action_number not in (
        select (a->>'action_number')::integer from jsonb_array_elements(bundle->'plan_actions') a
      );
  end if;

  if jsonb_typeof(bundle->'desk_items') = 'array' then
    insert into public.desk_items (merchant_id, case_id, trigger, fix_type, reason, mode, status, deadline)
    select r.merchant_id, v_case_id, r.trigger, r.fix_type, r.reason, r.mode, coalesce(r.status, 'proposed'), r.deadline
    from jsonb_populate_recordset(null::public.desk_items, bundle->'desk_items') r;
  end if;

  if bundle ? 'triage_result' then
    insert into public.triage_results (event_id, label, decided_by, evidence, agent_strength)
    select r.event_id, r.label, r.decided_by, r.evidence, r.agent_strength
    from jsonb_populate_record(null::public.triage_results, bundle->'triage_result') r;
  end if;

  if bundle ? 'event_id' then
    update public.debit_events set processed = true where event_id = bundle->>'event_id';
  end if;

  if jsonb_typeof(bundle->'audit') = 'array' then
    insert into public.audit_log (clock_date, actor, case_id, decision, internal_reason, public_reason, inputs,
      policy_version, model_version)
    select r.clock_date, r.actor, r.case_id, r.decision, r.internal_reason, r.public_reason, r.inputs,
      r.policy_version, r.model_version
    from jsonb_populate_recordset(null::public.audit_log, bundle->'audit') r;
  end if;

  return jsonb_build_object('case_id', v_case_id, 'updated_at', saved_at);
end
$$;

-- ---------------------------------------------------------------------------
-- reset_demo
--
-- Empties every table a demo run fills, audit_log included, and puts back the seeded settings
-- and clock from private.seed_snapshot. Then writes one audit row saying who reset it.
-- Rows added after the seed (for example a test merchant) are left alone.
-- Runs as its owner (security definer), because only the owner may empty tables. The row trigger
-- that makes audit_log append-only does not fire on an emptying, and no app role can empty a table.
-- ---------------------------------------------------------------------------

create function public.reset_demo(p_actor text, p_policy_version text) returns date
language plpgsql security definer set search_path = ''
as $$
declare
  seeded_today date;
begin
  if (select count(*) from private.seed_snapshot) < 5 then
    raise exception 'The seed copy is missing. Run npm run db:seed first.' using errcode = '55000';
  end if;

  truncate table
    public.audit_log, public.messages, public.desk_items, public.schedule_options, public.plan_actions,
    public.merchant_cases, public.triage_results, public.debit_events, public.cases, public.llm_runs, public.usage
  restart identity;

  update public.merchants t set
    name = s.name, type = s.type, layer_enabled = s.layer_enabled, kill_switch = s.kill_switch,
    polish_on = s.polish_on, consent_date = s.consent_date
  from jsonb_populate_recordset(null::public.merchants,
    (select rows from private.seed_snapshot where table_name = 'merchants')) s
  where t.id = s.id;

  update public.products t set
    name = s.name, segment = s.segment, rail = s.rail, last_allowed_day = s.last_allowed_day,
    max_representations = s.max_representations, standing_default = s.standing_default,
    result_delay_days = s.result_delay_days, penal_charge_per_day_paise = s.penal_charge_per_day_paise,
    bounce_charge_paise = s.bounce_charge_paise, baseline_retry_days = s.baseline_retry_days, grace_days = s.grace_days
  from jsonb_populate_recordset(null::public.products,
    (select rows from private.seed_snapshot where table_name = 'products')) s
  where t.id = s.id;

  insert into public.fix_settings as t (merchant_id, fix_type, mode)
  select s.merchant_id, s.fix_type, s.mode
  from jsonb_populate_recordset(null::public.fix_settings,
    (select rows from private.seed_snapshot where table_name = 'fix_settings')) s
  on conflict on constraint fix_settings_pkey do update set mode = excluded.mode;

  update public.consents t set
    status = s.status, granted_date = s.granted_date, withdrawn_date = s.withdrawn_date
  from jsonb_populate_recordset(null::public.consents,
    (select rows from private.seed_snapshot where table_name = 'consents')) s
  where t.id = s.id;

  select (rows->0->>'today')::date into seeded_today from private.seed_snapshot where table_name = 'sim_clock';
  update public.sim_clock set today = seeded_today where id;

  insert into public.audit_log (clock_date, actor, decision, internal_reason, public_reason, policy_version)
  values (seeded_today, p_actor, 'demo_reset',
    'Demo reset: cases, events and the audit log emptied; seeded settings and clock restored.',
    null, p_policy_version);

  return seeded_today;
end
$$;

-- Only the secret key may call these. Supabase lets every API role call new functions by default.
revoke execute on function public.save_case_bundle(jsonb) from public, anon, authenticated;
revoke execute on function public.reset_demo(text, text) from public, anon, authenticated;
grant execute on function public.save_case_bundle(jsonb), public.reset_demo(text, text) to service_role;

notify pgrst, 'reload schema';
