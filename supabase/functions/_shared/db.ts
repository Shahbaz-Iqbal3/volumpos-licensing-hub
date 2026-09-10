// Supabase admin client for the hub. Uses the service_role key, which bypasses
// the RLS lockdown in the migration. Never expose this key to a client.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
export type { SupabaseClient }

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceRole) throw new Error('Hub misconfigured: Supabase service credentials missing')
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

/** The family signing key. Secrets, never returned to a client. */
export function signingKey(): string {
  const key = Deno.env.get('LICENSE_PRIVATE_KEY')
  if (!key) throw new Error('Hub misconfigured: LICENSE_PRIVATE_KEY missing')
  return key
}

/** Optional shared secret so only our own admin tooling can mint keys. */
export function adminSecret(): string | null {
  return Deno.env.get('LICENSE_ADMIN_SECRET') ?? null
}

export type LicenseRow = {
  id: string
  customer_id: string
  product: string
  license_type: 'perpetual' | 'subscription'
  tier: string | null
  duration_months: number | null
  features: string[] | null
  activation_limit: number
  status: string
  key_hash: string
  key_last4: string
  issued_at: string
  expires_at: string | null
  subscription_id: string | null
}

export type CustomerRow = {
  id: string
  name: string
  phone: string | null
  email: string | null
}

export type ActivationRow = {
  id: string
  license_id: string
  machine_fingerprint: string
  fingerprint_sources: Record<string, string> | null
  machine_label: string | null
  activated_at: string
  last_seen_at: string | null
  deactivated_at: string | null
}

export type SubscriptionRow = {
  id: string
  customer_id: string
  product: string
  status: string
  billing_cycle_months: number
  next_billing_date: string | null
}

/** Append to the check-in log. Never throws — logging must not break a request. */
export async function logCheckin(
  client: SupabaseClient,
  entry: {
    license_id?: string | null
    machine_fingerprint?: string | null
    action: 'activate' | 'renew' | 'verify' | 'admin'
    result: 'ok' | 'denied'
    reason?: string | null
    ip?: string | null
  }
): Promise<void> {
  try {
    await client.from('checkin_log').insert({
      license_id: entry.license_id ?? null,
      machine_fingerprint: entry.machine_fingerprint ?? null,
      action: entry.action,
      result: entry.result,
      reason: entry.reason ?? null,
      ip: entry.ip ?? null
    })
  } catch {
    // ignored on purpose
  }
}
