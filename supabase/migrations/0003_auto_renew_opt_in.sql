-- Auto-renew is an explicit operator choice for new subscriptions.
-- Existing values are preserved; only the default for future inserts changes.
alter table public.subscriptions
  alter column auto_renew set default false;
