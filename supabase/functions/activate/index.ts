// POST /activate
//
// First-time activation for one machine. One round trip, no manual
// fingerprint/file exchange:
//   1. Customer enters a purchase key.
//   2. App sends { license_key, machine_fingerprint, sources, product }.
//   3. Hub validates the key, checks the activation limit (re-issuing instead
//      of consuming a seat when the same machine comes back), signs a license
//      bound to this fingerprint, records the activation, and returns it.
//
// From then on, normal usage is fully offline. Internet was only needed here.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { json, preflight, methodNotAllowed, clientIp } from '../_shared/http.ts'
import { serviceClient, signingKey, logCheckin, type LicenseRow } from '../_shared/db.ts'
import { hashLicenseKey } from '../_shared/keys.ts'
import { sanitizeSources, signLicensePayload } from '../_shared/licenseSign.ts'
import { decideActivation, resolveEntitlement } from '../_shared/logic.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return methodNotAllowed()

  const ip = clientIp(req)
  const db = serviceClient()

  let licenseId: string | null = null
  let fingerprint: string | null = null

  try {
    const body: any = await req.json().catch(() => null)

    const rawKey = typeof body?.license_key === 'string' ? body.license_key : ''
    fingerprint = typeof body?.machine_fingerprint === 'string' ? body.machine_fingerprint : ''
    const requestedProduct = typeof body?.product === 'string' ? body.product : ''
    const sources = sanitizeSources(body?.sources)
    const machineLabel = typeof body?.machine_label === 'string' ? body.machine_label.slice(0, 120) : null

    if (!rawKey || !fingerprint || !requestedProduct) {
      return json({ error: 'license_key, machine_fingerprint and product are required' }, 400)
    }

    const keyHash = await hashLicenseKey(rawKey)
    const { data: license, error } = await db
      .from('licenses')
      .select('*')
      .eq('key_hash', keyHash)
      .maybeSingle()

    if (error || !license) {
      await logCheckin(db, { action: 'activate', result: 'denied', reason: 'unknown key', ip })
      return json({ error: 'License key not recognised' }, 404)
    }

    licenseId = license.id

    if (license.product !== requestedProduct) {
      await logCheckin(db, {
        license_id: licenseId, machine_fingerprint: fingerprint, action: 'activate',
        result: 'denied', reason: 'product mismatch', ip
      })
      return json({ error: `This key is for ${license.product}, not ${requestedProduct}` }, 409)
    }

    // Subscription- or status-based entitlement.
    let subscriptionStatus: string | null = null
    if (license.subscription_id) {
      const { data: sub } = await db
        .from('subscriptions')
        .select('status')
        .eq('id', license.subscription_id)
        .maybeSingle()
      subscriptionStatus = sub?.status ?? null
    }

    const entitlement = resolveEntitlement({
      id: license.id,
      product: license.product,
      licenseType: license.license_type,
      status: license.status,
      activationLimit: license.activation_limit,
      expiresAt: license.expires_at,
      durationMonths: license.duration_months,
      subscriptionStatus
    })

    if (!entitlement.allowed) {
      await logCheckin(db, {
        license_id: licenseId, machine_fingerprint: fingerprint, action: 'activate',
        result: 'denied', reason: entitlement.reason, ip
      })
      return json({ error: entitlement.reason }, 403)
    }

    // Existing activations, to decide seat vs re-issue.
    const { data: activations } = await db
      .from('machine_activations')
      .select('machine_fingerprint, fingerprint_sources, deactivated_at')
      .eq('license_id', license.id)

    const decision = decideActivation({
      fingerprint,
      fingerprintSources: sources,
      activationLimit: license.activation_limit,
      activations: activations ?? []
    })

    if (decision.action === 'deny') {
      await logCheckin(db, {
        license_id: licenseId, machine_fingerprint: fingerprint, action: 'activate',
        result: 'denied', reason: decision.reason, ip
      })
      return json({ error: decision.reason }, 409)
    }

    const now = new Date().toISOString()
    if (decision.action === 'new-seat') {
      const { error: insertError } = await db.from('machine_activations').insert({
        license_id: license.id,
        machine_fingerprint: fingerprint,
        fingerprint_sources: sources ?? null,
        machine_label: machineLabel,
        activated_at: now,
        last_seen_at: now
      })
      if (insertError) {
        await logCheckin(db, {
          license_id: licenseId, machine_fingerprint: fingerprint, action: 'activate',
          result: 'denied', reason: 'activation insert failed', ip
        })
        return json({ error: 'Could not record activation' }, 500)
      }
    } else {
      // Re-issue: the machine is already known (exactly or fuzzily). Update the
      // stored row keyed by the fingerprint we actually matched, and re-bind it
      // to the current fingerprint in case hardware changed.
      await db
        .from('machine_activations')
        .update({
          machine_fingerprint: fingerprint,
          fingerprint_sources: sources ?? null,
          machine_label: machineLabel ?? undefined,
          last_seen_at: now,
          deactivated_at: null
        })
        .eq('license_id', license.id)
        .eq('machine_fingerprint', decision.matchedFingerprint)
    }

    const signed = await signLicensePayload(
      {
        licenseId: license.id,
        customerId: license.customer_id,
        product: license.product,
        licenseType: license.license_type,
        shopName: body?.shop_name && typeof body.shop_name === 'string' ? body.shop_name : '',
        fingerprint,
        sources,
        expiresAt: entitlement.expiresAt,
        tier: license.tier ?? undefined,
        features: license.features ?? undefined,
        durationMonths: license.duration_months ?? undefined,
        activationLimit: license.activation_limit,
        issuedAt: now
      },
      signingKey()
    )

    if (license.status === 'unactivated') {
      await db.from('licenses').update({ status: 'active' }).eq('id', license.id)
    }
    await db
      .from('licenses')
      .update({ last_signature: signed, last_issued_to: fingerprint })
      .eq('id', license.id)

    await logCheckin(db, {
      license_id: license.id, machine_fingerprint: fingerprint, action: 'activate',
      result: 'ok', reason: decision.reason, ip
    })

    return json({
      ok: true,
      license: signed,
      license_id: license.id,
      product: license.product,
      license_type: license.license_type,
      tier: license.tier,
      expires_at: entitlement.expiresAt,
      activation_limit: license.activation_limit,
      reinstated: decision.action === 'reissue'
    })
  } catch (err) {
    await logCheckin(db, {
      license_id: licenseId, machine_fingerprint: fingerprint, action: 'activate',
      result: 'denied', reason: String((err as Error)?.message ?? err), ip
    })
    return json({ error: 'Activation unavailable' }, 500)
  }
})
