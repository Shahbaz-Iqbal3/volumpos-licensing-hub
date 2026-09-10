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
  | { allowed: false; reason: string }

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
  if (license.status === 'revoked') return { allowed: false, reason: 'License revoked' }
  if (license.status === 'suspended') return { allowed: false, reason: 'License suspended' }

  if (license.licenseType === 'subscription') {
    const subStatus = license.subscriptionStatus
    if (subStatus === 'cancelled') return { allowed: false, reason: 'Subscription cancelled' }
    if (subStatus === 'past_due') return { allowed: false, reason: 'Subscription payment past due' }
    if (subStatus === 'paused') return { allowed: false, reason: 'Subscription paused' }
    if (subStatus && subStatus !== 'active') {
      return { allowed: false, reason: `Subscription ${subStatus}` }
    }
    // Subscription licenses always carry an expiry; signed at renewal.
    if (!license.expiresAt) return { allowed: false, reason: 'Subscription has no active period' }
    const expiry = new Date(license.expiresAt).getTime()
    if (Number.isFinite(expiry) && expiry + SUBSCRIPTION_BUFFER_DAYS * DAY_MS < now.getTime()) {
      return { allowed: false, reason: 'Subscription period lapsed' }
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
