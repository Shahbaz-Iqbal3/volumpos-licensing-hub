// POST /renew
//
// Silent subscription check-in. The customer enters a purchase key exactly once
// (at activation); from then on renewals use the stored `license_id` plus the
// machine fingerprint, so there is never a second key prompt.
//
// The app calls this when its stored license is within ~5 days of expiry and
// the network is available. If the subscription is active, the hub signs a
// fresh license with a new `expires_at` and returns it. If not, it says so and
// the app shows a billing banner — the fix is on the billing side.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { json, preflight, methodNotAllowed, clientIp } from '../_shared/http.ts'
import { serviceClient, signingKey, logCheckin, type LicenseRow } from '../_shared/db.ts'
import { sanitizeSources, signLicensePayload } from '../_shared/licenseSign.ts'
import { resolveEntitlement, nextRenewalExpiry } from '../_shared/logic.ts'
import { SUBSCRIPTION_BUFFER_DAYS } from '../_shared/constants.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight(req)
  if (req.method !== 'POST') return methodNotAllowed(req)

  const ip = clientIp(req)
  const db = serviceClient()

  let licenseId: string | null = null
  let fingerprint: string | null = null

  try {
    const body: any = await req.json().catch(() => null)
    licenseId = typeof body?.license_id === 'string' ? body.license_id : null
    fingerprint = typeof body?.machine_fingerprint === 'string' ? body.machine_fingerprint : ''
    const shopName = typeof body?.shop_name === 'string' ? body.shop_name : ''
    const sources = sanitizeSources(body?.sources)

    if (!licenseId || !fingerprint) {
      return json({ error: 'license_id and machine_fingerprint are required' }, 400)
    }

    const { data: license, error } = await db
      .from('licenses')
      .select('*')
      .eq('id', licenseId)
      .maybeSingle()

    if (error || !license) {
      await logCheckin(db, { license_id: licenseId, machine_fingerprint: fingerprint, action: 'renew', result: 'denied', reason: 'unknown license', ip })
      return json({ error: 'License not recognised' }, 404)
    }

    // The machine must already be activated on this license.
    const { data: activation } = await db
      .from('machine_activations')
      .select('id, deactivated_at')
      .eq('license_id', license.id)
      .eq('machine_fingerprint', fingerprint)
      .maybeSingle()

    if (!activation || activation.deactivated_at) {
      await logCheckin(db, { license_id: licenseId, machine_fingerprint: fingerprint, action: 'renew', result: 'denied', reason: 'not activated', ip })
      return json({ error: 'This machine is not activated for the license' }, 403)
    }

    let subscription: { status: string; billing_cycle_months: number; auto_renew?: boolean; auto_renew_until?: string | null } | null = null
    if (license.subscription_id) {
      const { data } = await db
        .from('subscriptions')
        .select('status, billing_cycle_months, auto_renew, auto_renew_until')
        .eq('id', license.subscription_id)
        .maybeSingle()
      subscription = data ?? null
    }

    const entitlement = resolveEntitlement({
      id: license.id,
      product: license.product,
      licenseType: license.license_type,
      status: license.status,
      activationLimit: license.activation_limit,
      expiresAt: license.expires_at,
      durationMonths: license.duration_months,
      subscriptionStatus: subscription?.status ?? null
    })

    if (!entitlement.allowed) {
      await logCheckin(db, { license_id: licenseId, machine_fingerprint: fingerprint, action: 'renew', result: 'denied', reason: entitlement.reason, ip })
      // 200 with a flag: an expected state, not a transport error. `billing`
      // distinguishes "fix your payment" from "contact support / admin action".
      return json({ ok: false, billing: entitlement.billing, error: entitlement.reason })
    }

    if (subscription && subscription.auto_renew === false) {
      await logCheckin(db, { license_id: license.id, machine_fingerprint: fingerprint, action: 'renew', result: 'denied', reason: 'Auto-renew disabled', ip })
      return json({ ok: false, billing: true, error: 'Auto-renew is disabled for this subscription' }, 200, req)
    }
    if (subscription?.auto_renew_until && new Date(subscription.auto_renew_until).getTime() < Date.now()) {
      await logCheckin(db, { license_id: license.id, machine_fingerprint: fingerprint, action: 'renew', result: 'denied', reason: 'Auto-renew term ended', ip })
      return json({ ok: false, billing: true, error: 'Auto-renew term has ended' }, 200, req)
    }

    // Compute the expiry to sign. Outside the renewal window nothing changes
    // (idempotent retries); inside it a subscription advances one billing cycle
    // plus the offline buffer. Perpetual licenses are never extended.
    const decision = nextRenewalExpiry({
      expiresAt: entitlement.expiresAt,
      licenseType: license.license_type,
      billingCycleMonths: subscription?.billing_cycle_months ?? license.duration_months,
      bufferDays: SUBSCRIPTION_BUFFER_DAYS
    })
    if (!decision.renew) {
      return json({ ok: true, renewed: false, expires_at: decision.expiresAt })
    }
    const expiresAt = decision.expiresAt

    const now = new Date().toISOString()
    const signed = await signLicensePayload(
      {
        licenseId: license.id,
        customerId: license.customer_id,
        product: license.product,
        licenseType: license.license_type,
        shopName,
        fingerprint,
        sources,
        expiresAt,
        tier: license.tier ?? undefined,
        features: license.features ?? undefined,
        durationMonths: license.duration_months ?? undefined,
        activationLimit: license.activation_limit,
        branchLimit: license.branch_limit ?? undefined,
        issuedAt: now
      },
      signingKey()
    )

    await db.from('licenses').update({ expires_at: expiresAt, last_signature: signed, last_issued_to: fingerprint }).eq('id', license.id)
    await db.from('machine_activations').update({ last_seen_at: now }).eq('id', activation.id)

    await logCheckin(db, { license_id: license.id, machine_fingerprint: fingerprint, action: 'renew', result: 'ok', reason: 'renewed', ip })

    return json({
      ok: true,
      renewed: true,
      license: signed,
      license_id: license.id,
      expires_at: expiresAt,
      activation_limit: license.activation_limit,
      branch_limit: license.branch_limit ?? 1
    })
  } catch (err) {
    await logCheckin(db, { license_id: licenseId, machine_fingerprint: fingerprint, action: 'renew', result: 'denied', reason: String((err as Error)?.message ?? err), ip })
    return json({ error: 'Renewal unavailable' }, 500)
  }
})
