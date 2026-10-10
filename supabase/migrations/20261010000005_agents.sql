-- Two database functions for the agents (build step 8). Only the secret key (service_role) may call them.
--
--   claim_agent_run(user, cap)                 counts one agent run against the user's daily limit.
--                                              True when the run may go ahead, false once the limit is used.
--   run_desk_items(merchant, ids, user, audit) marks a merchant's proposed desk items done and appends
--                                              their audit rows, all or nothing.

-- ---------------------------------------------------------------------------
-- claim_agent_run
--
-- The limit counts against the real date in UTC, not sim_clock.today (decided 10 October 2026):
-- it exists to cap real spending on the Anthropic key, and the demo clock can be moved forward at
-- will. This is the only place that reads the real date. Reset demo empties public.usage.
-- One statement, so two runs at the same moment cannot both take the last place.
-- ---------------------------------------------------------------------------

create function public.claim_agent_run(p_user uuid, p_cap integer) returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  runs integer;
begin
  insert into public.usage as u (user_id, date, agent_runs)
  values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict on constraint usage_pkey do update set agent_runs = u.agent_runs + 1
    where u.agent_runs < p_cap
  returning agent_runs into runs;
  return runs is not null and runs <= p_cap;
end
$$;

-- ---------------------------------------------------------------------------
-- run_desk_items
--
-- Called by approve-fixes after it has checked the items. If any item is no longer proposed or
-- belongs to another merchant, nothing is saved (error 40001, "desk_changed") and the caller reloads.
-- ---------------------------------------------------------------------------

create function public.run_desk_items(p_merchant text, p_ids bigint[], p_user uuid, p_audit jsonb) returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  changed integer;
begin
  update public.desk_items set status = 'done', decided_by = p_user
  where id = any (p_ids) and merchant_id = p_merchant and status = 'proposed';
  get diagnostics changed = row_count;
  if changed <> coalesce(array_length(p_ids, 1), 0) then
    raise exception 'desk_changed' using errcode = '40001';
  end if;

  if jsonb_typeof(p_audit) = 'array' then
    insert into public.audit_log (clock_date, actor, case_id, decision, internal_reason, public_reason, inputs,
      policy_version, model_version)
    select r.clock_date, r.actor, r.case_id, r.decision, r.internal_reason, r.public_reason, r.inputs,
      r.policy_version, r.model_version
    from jsonb_populate_recordset(null::public.audit_log, p_audit) r;
  end if;
  return changed;
end
$$;

revoke execute on function public.claim_agent_run(uuid, integer) from public, anon, authenticated;
revoke execute on function public.run_desk_items(text, bigint[], uuid, jsonb) from public, anon, authenticated;
grant execute on function public.claim_agent_run(uuid, integer), public.run_desk_items(text, bigint[], uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
