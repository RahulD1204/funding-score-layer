-- Access rules for the 26 tables (specs/04-data-model.md "Rules to enforce", specs/08-security.md rows 1, 3, 4, 5, 15).
--
-- Postgres roles used by Supabase:
--   anon           no login. Reads and writes nothing.
--   authenticated  any logged-in user. Reads only, and row-level security decides which rows.
--                  The app role (lender, insurer, ops) comes from public.profiles, never from the
--                  login's metadata, which a user can edit for themselves.
--   service_role   the secret key, used only by server functions. Reads, inserts and updates.
-- Nobody deletes rows ("Nothing is hard-deleted"). audit_log also refuses every update and delete,
-- whoever asks. Only the database owner can empty tables, which is what the seed script does.

-- ---------------------------------------------------------------------------
-- Who is asking. Kept in a schema the API does not expose.
-- These run as their owner (security definer) so they can read profiles whatever the caller's rules.
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create function private.my_role() returns text
language sql stable security definer set search_path = ''
as $$ select role from public.profiles where user_id = auth.uid() $$;

create function private.my_merchant_id() returns text
language sql stable security definer set search_path = ''
as $$ select merchant_id from public.profiles where user_id = auth.uid() $$;

create function private.my_merchant_type() returns text
language sql stable security definer set search_path = ''
as $$
  select m.type from public.profiles p join public.merchants m on m.id = p.merchant_id
  where p.user_id = auth.uid()
$$;

create function private.is_ops() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce((select role = 'ops' from public.profiles where user_id = auth.uid()), false) $$;

revoke execute on all functions in schema private from public;
grant execute on function private.my_role(), private.my_merchant_id(), private.my_merchant_type(), private.is_ops()
  to authenticated;

-- ---------------------------------------------------------------------------
-- Integrity guards. They hold whoever writes, including server functions.
-- ---------------------------------------------------------------------------

-- A profile's role must match its merchant's type, and nobody may change their own role or merchant.
create function private.guard_profile() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.user_id = auth.uid()
     and (new.role is distinct from old.role or new.merchant_id is distinct from old.merchant_id) then
    raise exception 'A user cannot change their own role or merchant' using errcode = '42501';
  end if;
  if new.role <> 'ops' and new.role is distinct from (select type from public.merchants where id = new.merchant_id) then
    raise exception 'Role % does not match the merchant''s type', new.role using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger profiles_guard before insert or update on public.profiles
  for each row execute function private.guard_profile();

-- Schedule options exist only for lenders. Insurers never get cards (specs/08-security.md row 3).
create function private.guard_schedule_option() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (select type from public.merchants where id = new.merchant_id) is distinct from 'lender' then
    raise exception 'Schedule options are for lenders only' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger schedule_options_lender_only before insert or update on public.schedule_options
  for each row execute function private.guard_schedule_option();

-- audit_log is append-only for every role, the database owner included.
create function private.reject_audit_change() returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only: % is not allowed', tg_op using errcode = '42501';
end
$$;
create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function private.reject_audit_change();

-- ---------------------------------------------------------------------------
-- Table privileges
-- ---------------------------------------------------------------------------

-- Start from nothing. Supabase grants everything to the API roles by default.
revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;
-- Tables added later start closed too, until a migration grants access on purpose.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;

-- Logged-in users may read; row-level security below decides which rows.
-- sim_truth is left out: only server functions (advance-day) and the tests read ground truth.
grant select on
  public.profiles, public.merchants, public.products, public.fix_settings,
  public.merchant_cases, public.schedule_options, public.desk_items,
  public.customers, public.obligations, public.consents, public.transactions, public.bank_downtimes,
  public.customer_signals, public.predictions, public.debit_events, public.triage_results, public.cases,
  public.plan_actions, public.audit_log, public.messages, public.model_card,
  public.sim_clock, public.prompts, public.llm_runs, public.usage
to authenticated;

-- Server functions read, insert and update. No delete anywhere, and no update on audit_log.
grant select, insert, update on all tables in schema public to service_role;
revoke update on public.audit_log from service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security. Every table has it on. With no policy, a table returns no rows.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$$;

-- Merchant-readable: a merchant user reads only their own merchant's rows. Ops reads every row.
create policy "own profile, or ops" on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_ops()));

create policy "own merchant, or ops" on public.merchants for select to authenticated
  using (id = (select private.my_merchant_id()) or (select private.is_ops()));

create policy "own merchant, or ops" on public.products for select to authenticated
  using (merchant_id = (select private.my_merchant_id()) or (select private.is_ops()));

create policy "own merchant, or ops" on public.fix_settings for select to authenticated
  using (merchant_id = (select private.my_merchant_id()) or (select private.is_ops()));

create policy "own merchant, or ops" on public.merchant_cases for select to authenticated
  using (merchant_id = (select private.my_merchant_id()) or (select private.is_ops()));

create policy "own merchant, or ops" on public.desk_items for select to authenticated
  using (merchant_id = (select private.my_merchant_id()) or (select private.is_ops()));

-- Schedule cards: lenders only, own rows only.
create policy "own lender, or ops" on public.schedule_options for select to authenticated
  using (
    (merchant_id = (select private.my_merchant_id()) and (select private.my_merchant_type()) = 'lender')
    or (select private.is_ops())
  );

-- Internal and system tables: ops only. sim_truth has no policy and no grant, so nobody logged in reads it.
do $$
declare t text;
begin
  foreach t in array array[
    'customers', 'obligations', 'consents', 'transactions', 'bank_downtimes', 'customer_signals',
    'predictions', 'debit_events', 'triage_results', 'cases', 'plan_actions', 'audit_log', 'messages',
    'model_card', 'sim_clock', 'prompts', 'llm_runs', 'usage'
  ] loop
    execute format(
      'create policy "ops only" on public.%I for select to authenticated using ((select private.is_ops()))', t
    );
  end loop;
end
$$;

-- Tell the API to pick up the new tables and rules.
notify pgrst, 'reload schema';
