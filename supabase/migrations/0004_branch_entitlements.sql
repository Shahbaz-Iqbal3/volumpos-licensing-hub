-- Branch entitlements are optional; existing licenses remain single-branch.
alter table public.licenses
  add column if not exists branch_limit integer not null default 1
  check (branch_limit >= 1);
