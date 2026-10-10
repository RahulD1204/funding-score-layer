-- Customer message text (build step 9).
--
--   messages.clock_date          the simulated date a message was written. created_at is the real
--                                time, which no screen may use (CLAUDE.md: all time logic uses sim_clock).
--   merchant_cases.customer_*    the merchant's copy of the latest message, its date and whether it is
--                                template text or polished wording. Merchants cannot read messages
--                                (an internal table), so the merchant screens read this copy.
--   store_customer_message(...)  stores one message, the merchant's copy and its audit row in a
--                                single transaction: all or nothing. No rules: lib/server builds the rows.

alter table public.messages add column clock_date date;
update public.messages set clock_date = created_at::date where clock_date is null;
alter table public.messages alter column clock_date set not null;

alter table public.merchant_cases
  add column customer_message text,
  add column customer_message_date date,
  add column customer_message_source text check (customer_message_source in ('template', 'polished'));

-- ---------------------------------------------------------------------------
-- store_customer_message
--
-- p_message = a messages row (case_id, audience, channel, body, source, template_version, facts, clock_date)
-- p_audit   = one audit_log row
-- A case with no merchant row stores nothing (error 22023).
-- Runs with the caller's rights (security invoker): only service_role may call it.
-- ---------------------------------------------------------------------------

create function public.store_customer_message(p_message jsonb, p_audit jsonb) returns bigint
language plpgsql security invoker set search_path = ''
as $$
declare
  m public.messages;
  a public.audit_log;
  new_id bigint;
  changed integer;
begin
  m := jsonb_populate_record(null::public.messages, p_message);

  update public.merchant_cases set
    customer_message = m.body,
    customer_message_date = m.clock_date,
    customer_message_source = m.source,
    updated_at = clock_timestamp()
  where case_id = m.case_id;
  get diagnostics changed = row_count;
  if changed <> 1 then
    raise exception 'store_customer_message: case % has no merchant row', m.case_id using errcode = '22023';
  end if;

  insert into public.messages (case_id, audience, channel, body, source, template_version, facts, clock_date)
  values (m.case_id, m.audience, m.channel, m.body, m.source, m.template_version, m.facts, m.clock_date)
  returning id into new_id;

  a := jsonb_populate_record(null::public.audit_log, p_audit);
  insert into public.audit_log (clock_date, actor, case_id, decision, internal_reason, public_reason, inputs,
    policy_version, model_version)
  values (a.clock_date, a.actor, a.case_id, a.decision, a.internal_reason, a.public_reason,
    coalesce(a.inputs, '{}'::jsonb) || jsonb_build_object('messageId', new_id), a.policy_version, a.model_version);

  return new_id;
end
$$;

revoke execute on function public.store_customer_message(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.store_customer_message(jsonb, jsonb) to service_role;

notify pgrst, 'reload schema';
