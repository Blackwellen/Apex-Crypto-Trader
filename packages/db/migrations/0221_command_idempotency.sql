-- APEX 0221: generic command idempotency for console commands that have no natural idempotency key
-- (manual incident, reconciliation exception, target plan, limit-increase request ...). Same user + same key + same payload
-- replays the stored result and performs NO second effect; same key + different payload is refused.
create table command_log (
  user_id uuid not null,
  idem_key text not null,
  command text not null,
  payload_hash text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, idem_key)
);
alter table command_log enable row level security; alter table command_log force row level security;   -- no policies: clients can never read or write it directly

create or replace function api_idem_begin(p_key text, p_cmd text, p_hash text) returns jsonb language plpgsql security definer set search_path = public as $$
declare r command_log%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  insert into command_log(user_id, idem_key, command, payload_hash) values (auth.uid(), p_key, p_cmd, p_hash) on conflict do nothing;
  select * into r from command_log where user_id = auth.uid() and idem_key = p_key;
  if r.payload_hash <> p_hash or r.command <> p_cmd then raise exception 'idempotency key reused with a different payload' using errcode='P0001'; end if;
  if r.result is not null then return jsonb_build_object('replay', true, 'result', r.result); end if;
  return jsonb_build_object('replay', false);
end $$;

create or replace function api_idem_finish(p_key text, p_result jsonb) returns void language plpgsql security definer set search_path = public as $$
begin
  update command_log set result = coalesce(p_result, '{}'::jsonb) where user_id = auth.uid() and idem_key = p_key;
end $$;

revoke execute on function api_idem_begin(text,text,text), api_idem_finish(text,jsonb) from public;
grant execute on function api_idem_begin(text,text,text), api_idem_finish(text,jsonb) to authenticated, service_role;
