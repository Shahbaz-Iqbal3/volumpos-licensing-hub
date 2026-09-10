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
import { sanitizeSources, signLicensePayload, addMonths } from '../_shared/licenseSign.ts'
import { resolveEntitlement, withinRenewalWindow } from '../_shared/logic.ts'
import { SUBSCRIPTION_BUFFER_DAYS } from '../_shared/constants.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return methodNotAllowed()

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

    let subscription: { status: string; billing_cycle_months: number } | null = null
    if (license.subscription_id) {
      const { data } = await db
        .from('subscriptions')
        .select('status, billing_cycle_months')
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
      // 200 with a billing flag: this is an expected state, not a transport error.
      return json({ ok: false, billing: true, error: entitlement.reason })
    }

    // Compute the signed expiry. For a subscription, extend past the current
    // period by the billing cycle plus a buffer so an offline gap is covered.
    let expiresAt = entitlement.expiresAt
    if (license.license_type === 'subscription' && subscription) {
      const base = license.expires_at && new Date(license.expires_at) > new Date()
        ? new Date(license.expires_at)
        : new Date()
      const extended = addMonths(subscription.billing_cycle_months, base)
      extended.setDate(extended.getDate() + SUBSCRIPTION_BUFFER_DAYS)
      expiresAt = extended.toISOString()
    } else if (!withinRenewalWindow(entitlement.expiresAt)) {
      // Perpetual license, not near expiry: nothing to do.
      return json({ ok: true, renewed: false, expires_at: entitlement.expiresAt })
    }

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
      activation_limit: license.activation_limit
    })
  } catch (err) {
    await logCheckin(db, { license_id: licenseId, machine_fingerprint: fingerprint, action: 'renew', result: 'denied', reason: String((err as Error)?.message ?? err), ip })
    return json({ error: 'Renewal unavailable' }, 500)
  }
})
