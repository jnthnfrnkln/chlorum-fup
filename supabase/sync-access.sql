-- Lets Claude's morning sync work on the portal through the equipe-portal
-- function, as a limited role: equipe tables only, no deletes, and it can
-- never read the personal link tokens.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'equipe_sync') then
    create role equipe_sync nologin;
  end if;
end $$;
grant equipe_sync to current_user;   -- lets the function switch to it

grant usage on schema equipe to equipe_sync;
grant select (slug, name, role, email, lang, is_admin, last_seen_at, created_at)
  on equipe.people to equipe_sync;    -- every column except token
grant select, insert, update on equipe.items   to equipe_sync;
grant select, insert, update on equipe.updates to equipe_sync;

drop policy if exists sync_read on equipe.people;
drop policy if exists sync_all  on equipe.items;
drop policy if exists sync_all  on equipe.updates;
create policy sync_read on equipe.people  for select to equipe_sync using (true);
create policy sync_all  on equipe.items   for all    to equipe_sync using (true) with check (true);
create policy sync_all  on equipe.updates for all    to equipe_sync using (true) with check (true);

-- Check: one row, "ok".
select case when has_column_privilege('equipe_sync', 'equipe.people', 'token', 'select')
            then 'PROBLEM: token readable' else 'ok' end as check;
