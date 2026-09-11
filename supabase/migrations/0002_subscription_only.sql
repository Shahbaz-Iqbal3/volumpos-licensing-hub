-- Subscription-only issuance controls. Existing perpetual rows are preserved
-- for migration/support; all new dashboard issuance is subscription-backed.
alter table public.subscriptions
  add column if not exists auto_renew boolean not null default true,
  add column if not exists auto_renew_until date;

comment on column public.subscriptions.auto_renew is
  'Whether the hub may issue the next billing cycle automatically.';
comment on column public.subscriptions.auto_renew_until is
  'Optional final date for automatic renewal; null means no scheduled end.';
