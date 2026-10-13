-- LOCAL/TEST ONLY. Supabase provides the `auth` schema, `auth.uid()` and the
-- anon/authenticated/service_role roles in real deployments. This shim reproduces
-- just enough of that contract (JWT sub read from request.jwt.claim.sub) for
-- running migrations and RLS tests against plain PostgreSQL.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text unique);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='apex_app') then create role apex_app login password 'apex_app' noinherit; end if;
end $$;
grant authenticated to apex_app;
