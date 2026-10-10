-- Reset demo keeps the daily agent-run counts (security review, step 10, decided 10 October 2026).
--
-- public.usage counts each user's agent runs against the real date, to cap real spending on the
-- Anthropic key (specs/08-security.md row 16). Emptying it on every reset let anyone with the ops
-- login start a fresh 50 runs at will. The count now restarts only when the real date changes.
-- The function is otherwise the one in 20261010000003_server_writes.sql. Replacing it keeps its
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
    'Demo reset: cases, events and the audit log emptied; seeded settings and clock restored. Today''s agent run counts are kept.',
    null, p_policy_version);

  return seeded_today;
end
$$;

notify pgrst, 'reload schema';
