// Pure decisions for activation and renewal. No Deno, no Supabase — the Edge
// Functions fetch rows and call these, and the tests call them directly.
import { SUBSCRIPTION_BUFFER_DAYS, DEFAULT_ACTIVATION_LIMIT, requiredSourceMatches } from './constants.ts'

export type LicenseState = {
  id: string
  product: string
  licenseType: 'perpetual' | 'subscription'
  status: string
  activationLimit: number
  expiresAt: string | null
  durationMonths: number | null
  subscriptionStatus?: string | null
}

export type Entitlement =
  | { allowed: true; expiresAt: string }
  | { allowed: false; reason: string; billing: boolean }

const DAY_MS = 86_400_000

/**
 * Whether this license still entitles the customer to a signed license, and
 * until when.
 *
 * - `suspended` / `revoked` are always denied.
 * - A subscription depends on the subscription's status; its expiry is the
 *   later of the license expiry and the subscription window, plus a buffer.
 * - A perpetual license uses its own `expiresAt`; if it has none it never
 *   expires (a true one-time grant).
 */
export function resolveEntitlement(license: LicenseState, now: Date = new Date()): Entitlement {
  // `billing: true` tells a client to show a billing/contact-support prompt.
  // Admin actions (revoked/suspended) are not billing problems, so they set it
  // false — otherwise the app would tell the customer to fix their payment.
  if (license.status === 'revoked') return { allowed: false, reason: 'License revoked', billing: false }
  if (license.status === 'suspended') return { allowed: false, reason: 'License suspended', billing: false }

  if (license.licenseType === 'subscription') {
    const subStatus = license.subscriptionStatus
    if (subStatus === 'cancelled') return { allowed: false, reason: 'Subscription cancelled', billing: true }
    if (subStatus === 'past_due') return { allowed: false, reason: 'Subscription payment past due', billing: true }
    if (subStatus === 'paused') return { allowed: false, reason: 'Subscription paused', billing: true }
    if (subStatus && subStatus !== 'active') {
      return { allowed: false, reason: `Subscription ${subStatus}`, billing: true }
    }
    // Subscription licenses always carry an expiry; signed at renewal.
    if (!license.expiresAt) return { allowed: false, reason: 'Subscription has no active period', billing: true }
    const expiry = new Date(license.expiresAt).getTime()
    // An active subscription may be reactivated after a payment gap. Let
    // /renew advance it from the stored last expiry (or from now if that date
    // is already past); do not reject it here as "lapsed" before renewal can
    // repair the entitlement.
    if (subStatus !== 'active' && Number.isFinite(expiry) && expiry + SUBSCRIPTION_BUFFER_DAYS * DAY_MS < now.getTime()) {
      return { allowed: false, reason: 'Subscription period lapsed', billing: true }
    }
  }

  if (!license.expiresAt) {
    // Perpetual with no expiry: valid forever (minus status checks above).
    const farFuture = new Date(now.getTime())
    farFuture.setFullYear(farFuture.getFullYear() + 50)
    return { allowed: true, expiresAt: farFuture.toISOString() }
  }

  return { allowed: true, expiresAt: new Date(license.expiresAt).toISOString() }
}

export type ActivationDecision =
  | { action: 'reissue'; reason: string; matchedFingerprint: string }
  | { action: 'new-seat'; reason: string }
  | { action: 'deny'; reason: string }

/**
 * Decide what an `/activate` call should do.
 *
 * Reissue-on-same-machine: if this fingerprint is already recorded and active,
 * it is the same physical machine reinstalling — no new seat is consumed.
 *
 * Fuzzy re-match: if the fingerprint is not an exact record but its per-source
 * hashes closely match an existing activation, treat it as the same machine
 * (tolerates a changed disk/NIC) and refresh the stored fingerprint.
 */
export function decideActivation(input: {
  fingerprint: string
  fingerprintSources?: Record<string, string>
  activationLimit: number
  activations: Array<{
    machine_fingerprint: string
    fingerprint_sources: Record<string, string> | null
    deactivated_at: string | null
  }>
}): ActivationDecision {
  const active = input.activations.filter((a) => a.deactivated_at === null)
  const limit = input.activationLimit > 0 ? input.activationLimit : DEFAULT_ACTIVATION_LIMIT

  const exact = active.find((a) => a.machine_fingerprint === input.fingerprint)
  if (exact) {
    return {
      action: 'reissue',
      reason: 'Already activated on this machine',
      matchedFingerprint: exact.machine_fingerprint
    }
  }

  if (input.fingerprintSources) {
    const incoming = input.fingerprintSources
    const nearMatch = active.find((a) => sourcesMatch(a.fingerprint_sources, incoming))
    if (nearMatch) {
      return {
        action: 'reissue',
        reason: 'Matches an existing activation (fuzzy)',
        matchedFingerprint: nearMatch.machine_fingerprint
      }
    }
  }

  if (active.length < limit) {
    return { action: 'new-seat', reason: 'Seat available' }
  }

  return {
    action: 'deny',
    reason: `Activation limit reached (${active.length}/${limit}). Deactivate a device or contact support.`
  }
}

/** Fuzzy compare: require half the recorded sources, minimum 1. Extra or
 *  missing sources are tolerated. */
export function sourcesMatch(
  expected: Record<string, string> | null,
  actual: Record<string, string>
): boolean {
  if (!expected) return false
  const keys = Object.keys(expected)
  if (keys.length === 0) return false
  let matched = 0
  for (const key of keys) {
    if (actual[key] && actual[key] === expected[key]) matched++
  }
  return matched >= requiredSourceMatches(keys.length)
}

/** The expiry to embed in a signed license. An expired perpetual license is
 *  still signed at its stored date; the client's grace logic governs lockout. */
export function signedExpiry(entitlement: Extract<Entitlement, { allowed: true }>): string {
  return entitlement.expiresAt
}

/** When a subscription license should next be re-signed. A renewal request
 *  inside this window returns a fresh license; outside it, the existing one. */
export function withinRenewalWindow(expiresAt: string, windowDays = 5, now: Date = new Date()): boolean {
  const expiry = new Date(expiresAt)
  if (isNaN(expiry.getTime())) return true
  const windowStart = new Date(expiry)
  windowStart.setDate(windowStart.getDate() - windowDays)
  return now >= windowStart
}

export function addMonths(months: number, from: Date = new Date()): Date {
  const date = new Date(from.getTime())
  date.setMonth(date.getMonth() + months)
  return date
}

export function addDays(days: number, from: Date = new Date()): Date {
  const date = new Date(from.getTime())
  date.setDate(date.getDate() + days)
  return date
}

export type RenewalDecision =
  | { renew: false; expiresAt: string }
  | { renew: true; expiresAt: string }

/**
 * Decide the expiry a `/renew` call should sign.
 *
 * Outside the renewal window nothing changes — the same expiry is returned, so
 * a retrying client (restart, flaky network) cannot stack extra billing cycles.
 * Inside the window a subscription is extended by one cycle plus the offline
 * buffer, which lands a full cycle out and so is idempotent on the next call.
 */
export function nextRenewalExpiry(input: {
  expiresAt: string
  licenseType: 'perpetual' | 'subscription'
  billingCycleMonths?: number | null
  bufferDays: number
  windowDays?: number
  now?: Date
}): RenewalDecision {
  const now = input.now ?? new Date()
  if (!withinRenewalWindow(input.expiresAt, input.windowDays ?? 5, now)) {
    return { renew: false, expiresAt: input.expiresAt }
  }

  if (input.licenseType !== 'subscription' || !input.billingCycleMonths) {
    // Perpetual licenses are not extended; re-sign the same expiry.
    return { renew: false, expiresAt: input.expiresAt }
  }

  // Always anchor at the stored subscription end. This is what makes a
  // reactivation resume the subscription timeline instead of silently starting
  // a new period from the date the license happened to be activated.
  const base = new Date(input.expiresAt)
  const extended = addMonths(input.billingCycleMonths, base)
  extended.setDate(extended.getDate() + input.bufferDays)
  return { renew: true, expiresAt: extended.toISOString() }
}
