-- The simulated date for every logged-in user (build step 7, decided 10 October 2026).
--
-- A merchant screen needs "today" to say whether a schedule can still be picked and whether a
-- date has locked. In production that is the real date, which every merchant already knows; in the
-- demo it is sim_clock.today. The sim_clock table itself stays ops-only: this function returns the
-- date and nothing else.

create function public.demo_today() returns date
language sql stable security definer set search_path = ''
as $$ select today from public.sim_clock $$;

revoke execute on function public.demo_today() from public, anon;
grant execute on function public.demo_today() to authenticated, service_role;

notify pgrst, 'reload schema';
