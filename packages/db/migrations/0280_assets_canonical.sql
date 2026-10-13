-- Canonical token identity: EVM contract addresses are case-insensitive hex, so store them lower-cased.
-- (Checksum casing is a display concern; chain+contract must resolve to exactly one asset.)
create or replace function assets_canonicalize() returns trigger language plpgsql as $$
begin
  if new.contract <> 'native' and exists (select 1 from chain_registry r where r.id = new.chain_id and r.family = 'evm') then
    new.contract := lower(new.contract);
  end if;
  return new;
end $$;
create trigger assets_canonicalize_biu before insert or update on assets for each row execute function assets_canonicalize();
