// Abuse throttling for the admin-gated functions.
//
// Edge Functions are stateless and horizontally scaled, so an in-memory counter
// would only throttle the instance that happens to serve the request. Instead we
// count recent failed authentication attempts in `checkin_log`, which every
// instance shares.
//
// This is deliberately simple: it slows down online guessing of the admin
// secret, and gives the abuse-detection phase real data to alert on. It is not
// a substitute for a strong secret or an auth gate in front of the panel.
import type { SupabaseClient } from './db.ts'

/** Failed secret attempts from one IP allowed inside the window. */
export const MAX_FAILED_ATTEMPTS = 20
/** Length of the window, in minutes. */
export const FAILED_ATTEMPT_WINDOW_MINUTES = 15
/** The log action recorded for a rejected admin secret. */
export const ADMIN_AUTH_ACTION = 'admin-auth'

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMinutes: number }

/**
 * True when this IP has already failed too many times recently.
 *
 * Called AFTER the secret is checked, and only on failure. That ordering
 * matters: a correct secret must never be throttled, or an attacker (or a typo)
 * could lock the real operator out of a shared/NAT IP for the whole window.
 * Fails open — a query error must not block the operator either.
 */
export async function checkAdminRateLimit(
  client: SupabaseClient,
  ip: string | null
): Promise<RateLimitResult> {
  if (!ip) return { allowed: true }
  try {
    const since = new Date(Date.now() - FAILED_ATTEMPT_WINDOW_MINUTES * 60_000).toISOString()
    const { count, error } = await client
      .from('checkin_log')
      .select('*', { count: 'exact', head: true })
      .eq('action', ADMIN_AUTH_ACTION)
      .eq('result', 'denied')
      .eq('ip', ip)
      .gte('created_at', since)

    if (error || count === null) return { allowed: true }
    if (count >= MAX_FAILED_ATTEMPTS) {
      return { allowed: false, retryAfterMinutes: FAILED_ATTEMPT_WINDOW_MINUTES }
    }
    return { allowed: true }
  } catch {
    return { allowed: true }
  }
}

/** Record a rejected admin secret so the next call can throttle on it. */
export async function recordAdminAuthFailure(
  client: SupabaseClient,
  ip: string | null,
  reason: string
): Promise<void> {
  try {
    await client.from('checkin_log').insert({
      action: ADMIN_AUTH_ACTION,
      result: 'denied',
      reason,
      ip
    })
  } catch {
    // ignored — logging must never break the response
  }
}
