-- OCR scan quota: track scans per license per calendar month.
-- The first OCR_FREE_SCANS_PER_MONTH scans are free; beyond that the
-- ocr-addon feature flag is required.
create table if not exists public.ocr_scan_usage (
  license_id  text not null references public.licenses(id) on delete cascade,
  month       text not null,                 -- 'YYYY-MM'
  scan_count  integer not null default 0 check (scan_count >= 0),
  updated_at  timestamptz not null default now(),
  primary key (license_id, month)
);

create index if not exists ocr_scan_usage_license_idx on public.ocr_scan_usage(license_id);

alter table public.ocr_scan_usage enable row level security;

-- No policies: only service_role (Edge Functions) touches this table.
comment on table public.ocr_scan_usage is
  'OCR scan usage counter per license per calendar month.'
