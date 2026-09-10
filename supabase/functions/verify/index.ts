// POST /verify
//
// Internal support/debug lookup. Not used by the products — they verify
// offline. Requires the admin secret (x-admin-secret), so it cannot be used to
// enumerate customers from the internet.
//
// Accepts either { license_key } (hashes it) or { license_id } / { customer_id }.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { json, preflight, methodNotAllowed, clientIp } from '../_shared/http.ts'
import { serviceClient, adminSecret, logCheckin } from '../_shared/db.ts'
import { hashLicenseKey } from '../_shared/keys.ts'
import { resolveEntitlement } from '../_shared/logic.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return methodNotAllowed()

  const ip = clientIp(req)
  const secret = adminSecret()
  if (!secret || req.headers.get('x-admin-secret') !== secret) {
    return json({ error: 'Forbidden' }, 403)
  }

  const db = serviceClient()

  try {
    const body: any = await req.json().catch(() => null)
    const rawKey = typeof body?.license_key === 'string' ? body.license_key : null
    const licenseId = typeof body?.license_id === 'string' ? body.license_id : null
    const customerId = typeof body?.customer_id === 'string' ? body.customer_id : null

    if (!rawKey && !licenseId && !customerId) {
      return json({ error: 'Provide license_key, license_id or customer_id' }, 400)
    }

    let query = db.from('licenses').select('*')
    if (rawKey) query = query.eq('key_hash', await hashLicenseKey(rawKey))
    else if (licenseId) query = query.eq('id', licenseId)
    else query = query.eq('customer_id', customerId as string)

    const { data: rows, error } = await query
    if (error) {
      await logCheckin(db, { action: 'verify', result: 'denied', reason: error.message, ip })
      return json({ error: 'Lookup failed' }, 500)
    }

    const licenses = rows ?? []
    const results = []
    for (const license of licenses) {
      const { data: customer } = await db
        .from('customers')
        .select('id, name, phone, email')
        .eq('id', license.customer_id)
        .maybeSingle()

      const { data: activations } = await db
        .from('machine_activations')
        .select('machine_fingerprint, machine_label, activated_at, last_seen_at, deactivated_at')
        .eq('license_id', license.id)

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

      results.push({
        license: {
          id: license.id,
          product: license.product,
          license_type: license.license_type,
          tier: license.tier,
          status: license.status,
          activation_limit: license.activation_limit,
          key_last4: license.key_last4,
          issued_at: license.issued_at,
          expires_at: license.expires_at
        },
        customer,
        subscription,
        activations: activations ?? [],
        entitled: entitlement.allowed,
        entitlement_reason: entitlement.allowed ? null : entitlement.reason
      })
    }

    await logCheckin(db, { action: 'verify', result: 'ok', reason: rawKey ? 'by key' : 'by id', ip })
    return json({ ok: true, count: results.length, results })
  } catch (err) {
    return json({ error: 'Verify unavailable', detail: String((err as Error)?.message ?? err) }, 500)
  }
})
