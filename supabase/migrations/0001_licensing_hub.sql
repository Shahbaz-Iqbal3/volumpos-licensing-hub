-- VolumPOS Licensing Hub — initial schema.
--
-- Developer-owned Supabase project. It stores customers, issued licenses,
-- subscriptions, machine activations, and a check-in log for abuse detection.
-- It is intentionally decoupled from any customer's own data-sync project.
--
-- Security model:
--   * RLS is enabled and NO policies are granted, so anon/authenticated roles
--     cannot read these tables at all. Only the service_role (used by the Edge
--     Functions) can touch them.
--   * The purchase key the customer types is NEVER stored in plain text. We
--     store a SHA-256 hash for lookup plus the last 4 characters for display.
--     The raw key is returned exactly once, when it is issued.
--   * Licenses are exposed only through the Edge Functions, never by table
--     access.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- customers
create table if not exists public.customers (
  id          text primary key,                 -- CUST-0042
  name        text not null,
  phone       text,
  email       text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- -------------------------------------------------------------- subscriptions
-- Created before licenses because licenses reference it.
create table if not exists public.subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         text not null references public.customers(id) on delete cascade,
  product             text not null,
  status              text not null default 'active'
                        check (status in ('active', 'past_due', 'cancelled', 'paused')),
  billing_cycle_months integer not null check (billing_cycle_months > 0),
  price_minor         bigint,
  currency            text not null default 'PKR',
  next_billing_date   date,
  started_at          timestamptz not null default now(),
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists subscriptions_customer_idx on public.subscriptions(customer_id);
create index if not exists subscriptions_status_idx on public.subscriptions(status);

-- ------------------------------------------------------------------ licenses
create table if not exists public.licenses (
  id                  text primary key,          -- LIC-0001872
  customer_id         text not null references public.customers(id) on delete restrict,
  product             text not null,             -- FABRIC_POS | RESTAURANT_POS | ...
  license_type        text not null default 'perpetual'
                        check (license_type in ('perpetual', 'subscription')),
  tier                text,                      -- 1y | 2y | 5y | custom | null
  duration_months     integer,                   -- subscription cycle length
  features            text[] not null default '{}',
  activation_limit    integer not null default 1 check (activation_limit >= 1),
  status              text not null default 'unactivated'
                        check (status in ('unactivated', 'active', 'suspended', 'expired', 'revoked')),
  is_custom           boolean not null default false,
  -- Purchase key: hash for lookup, last 4 for display. Raw key is never stored.
  key_hash            text not null unique,
  key_last4           text not null,
  -- Perpetual licenses get an expiry at issue; subscriptions get it on renew.
  issued_at           timestamptz not null default now(),
  expires_at          timestamptz,
  subscription_id     uuid references public.subscriptions(id) on delete set null,
  -- Last signed license handed to a machine (optional cache for support).
  last_signature      text,
  last_issued_to      text,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists licenses_customer_idx on public.licenses(customer_id);
create index if not exists licenses_product_idx on public.licenses(product);
create index if not exists licenses_status_idx on public.licenses(status);
create index if not exists licenses_subscription_idx on public.licenses(subscription_id);

-- -------------------------------------------------------- machine_activations
create table if not exists public.machine_activations (
  id                  uuid primary key default gen_random_uuid(),
  license_id          text not null references public.licenses(id) on delete cascade,
  machine_fingerprint text not null,
  fingerprint_sources jsonb,                     -- per-source hashes, for fuzzy re-match
  machine_label       text,
  activated_at        timestamptz not null default now(),
  last_seen_at        timestamptz,
  deactivated_at      timestamptz,
  unique (license_id, machine_fingerprint)
);

create index if not exists activations_license_idx on public.machine_activations(license_id);
create index if not exists activations_active_idx
  on public.machine_activations(license_id) where deactivated_at is null;

-- --------------------------------------------------------------- checkin_log
create table if not exists public.checkin_log (
  id                  bigserial primary key,
  license_id          text,
  machine_fingerprint text,
  action              text not null,             -- activate | renew | verify | admin
  result              text not null,             -- ok | denied
  reason              text,
  ip                  text,
  created_at          timestamptz not null default now()
);

create index if not exists checkin_license_idx on public.checkin_log(license_id);
create index if not exists checkin_created_idx on public.checkin_log(created_at desc);

-- ------------------------------------------------ updated_at auto-touch
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists customers_touch on public.customers;
create trigger customers_touch before update on public.customers
  for each row execute function public.touch_updated_at();

drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();

drop trigger if exists licenses_touch on public.licenses;
create trigger licenses_touch before update on public.licenses
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------- RLS lockdown
alter table public.customers          enable row level security;
alter table public.subscriptions      enable row level security;
alter table public.licenses           enable row level security;
alter table public.machine_activations enable row level security;
alter table public.checkin_log        enable row level security;

-- No policies are created on purpose: anon and authenticated roles get nothing.
-- The Edge Functions use the service_role key, which bypasses RLS.

-- ------------------------------------------------------------- id sequences
-- Human-readable ids (CUST-0042, LIC-0001872). Kept as a tiny counter table so
-- issuance is race-safe without depending on row counts.
create table if not exists public.id_counters (
  name       text primary key,
  last_value bigint not null default 0
);

insert into public.id_counters (name, last_value)
values ('customer', 0), ('license', 0)
on conflict (name) do nothing;

alter table public.id_counters enable row level security;

create or replace function public.next_id(prefix text, counter text, width int)
returns text
language plpgsql
as $$
declare
  value bigint;
begin
  update public.id_counters
     set last_value = last_value + 1
   where name = counter
  returning last_value into value;

  if value is null then
    insert into public.id_counters (name, last_value) values (counter, 1)
    returning last_value into value;
  end if;

  return prefix || lpad(value::text, width, '0');
end;
$$;
