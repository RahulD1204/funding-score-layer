-- Replayed history (specs/00 "Replayed history", decided 12 October 2026).
--
-- The seed plays every failed February and March 2026 debit through the real server functions
-- (scripts/history.ts), then calls private.take_history_snapshot() to keep a copy of every case
-- table. reset_demo empties those tables as before and puts the copy back, so every judge starts
-- from the same screens. The copy keeps the rows' own ids; the id counters move past them.
-- audit_log stays append-only: the restore only inserts.

create table private.history_snapshot (
  table_name text primary key,
  rows jsonb not null,
  taken_at timestamptz not null default now()
);
comment on table private.history_snapshot is 'The replayed February and March case rows that reset_demo restores. Not app data; never readable by an app user';
alter table private.history_snapshot enable row level security;
revoke all on private.history_snapshot from public, anon, authenticated, service_role;

-- Called by scripts/seed.ts, as the owner, after the history is built.
create function private.take_history_snapshot() returns void
language sql set search_path = ''
as $$
  delete from private.history_snapshot where true;
  insert into private.history_snapshot (table_name, rows)
  select 'debit_events', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.debit_events t
  union all select 'cases', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.cases t
  union all select 'triage_results', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.triage_results t
  union all select 'merchant_cases', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.merchant_cases t
  union all select 'schedule_options', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.schedule_options t
  union all select 'plan_actions', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.plan_actions t
  union all select 'desk_items', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.desk_items t
  union all select 'messages', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.messages t
  union all select 'llm_runs', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.llm_runs t
  union all select 'audit_log', coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.audit_log t;
$$;
revoke execute on function private.take_history_snapshot() from public, anon, authenticated, service_role;

-- Inserts the copy into the emptied case tables, parents first, and moves the id counters past it.
create function private.restore_history() returns void
language plpgsql set search_path = ''
as $$
begin
  insert into public.debit_events
  select * from jsonb_populate_recordset(null::public.debit_events, (select rows from private.history_snapshot where table_name = 'debit_events'));
  insert into public.cases
  select * from jsonb_populate_recordset(null::public.cases, (select rows from private.history_snapshot where table_name = 'cases'));
  insert into public.triage_results
  select * from jsonb_populate_recordset(null::public.triage_results, (select rows from private.history_snapshot where table_name = 'triage_results'));
  insert into public.merchant_cases
  select * from jsonb_populate_recordset(null::public.merchant_cases, (select rows from private.history_snapshot where table_name = 'merchant_cases'));
  insert into public.schedule_options
  select * from jsonb_populate_recordset(null::public.schedule_options, (select rows from private.history_snapshot where table_name = 'schedule_options'));
  insert into public.plan_actions
  select * from jsonb_populate_recordset(null::public.plan_actions, (select rows from private.history_snapshot where table_name = 'plan_actions'));
  insert into public.desk_items overriding system value
  select * from jsonb_populate_recordset(null::public.desk_items, (select rows from private.history_snapshot where table_name = 'desk_items'));
  insert into public.messages overriding system value
  select * from jsonb_populate_recordset(null::public.messages, (select rows from private.history_snapshot where table_name = 'messages'));
  insert into public.llm_runs overriding system value
  select * from jsonb_populate_recordset(null::public.llm_runs, (select rows from private.history_snapshot where table_name = 'llm_runs'));
  insert into public.audit_log overriding system value
  select * from jsonb_populate_recordset(null::public.audit_log, (select rows from private.history_snapshot where table_name = 'audit_log'));
  perform setval(pg_get_serial_sequence('public.audit_log', 'id'), coalesce((select max(id) from public.audit_log), 0) + 1, false);
  perform setval(pg_get_serial_sequence('public.desk_items', 'id'), coalesce((select max(id) from public.desk_items), 0) + 1, false);
  perform setval(pg_get_serial_sequence('public.llm_runs', 'id'), coalesce((select max(id) from public.llm_runs), 0) + 1, false);
  perform setval(pg_get_serial_sequence('public.messages', 'id'), coalesce((select max(id) from public.messages), 0) + 1, false);
end
$$;
revoke execute on function private.restore_history() from public, anon, authenticated, service_role;

-- reset_demo as in 20261010000007_reset_keeps_usage.sql, plus the restore. Replacing it keeps its
-- grants: only service_role may call it.
create or replace function public.reset_demo(p_actor text, p_policy_version text) returns date
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
    public.merchant_cases, public.triage_results, public.debit_events, public.cases, public.llm_runs
  restart identity;

  -- Put the replayed February and March history back (empty if the seed built none).
  perform private.restore_history();

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
    'Demo reset: cases, events and the audit log emptied and the replayed February and March history restored; seeded settings and clock restored. Today''s agent run counts are kept.',
    null, p_policy_version);

  return seeded_today;
end
$$;

notify pgrst, 'reload schema';
