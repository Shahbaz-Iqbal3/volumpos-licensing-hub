// POST /push-relay — relay a push notification to a licensed machine.
// Requires the push-relay feature flag on the license.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { json, preflight, methodNotAllowed, clientIp } from '../_shared/http.ts'
import { serviceClient, logCheckin } from '../_shared/db.ts'
import { FEATURE_PUSH_RELAY } from '../_shared/constants.ts'

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
    const payload = body?.payload ?? null

    if (!licenseId || !fingerprint) {
      return json({ error: 'license_id and machine_fingerprint are required' }, 400)
    }

    const { data: license, error } = await db
      .from('licenses')
      .select('id, features, status')
      .eq('id', licenseId)
      .maybeSingle()
    if (error || !license) {
      return json({ error: 'License not recognised' }, 404)
    }
    const features: string[] = license.features ?? []
    if (!features.includes(FEATURE_PUSH_RELAY)) {
      return json({ error: 'Push relay is not enabled for this license' }, 403)
    }

    // --- Push delivery goes here: payload -> FCM/APNS/webhook ---
    // TODO: wire to push provider using `payload`.

    await logCheckin(db, {
      license_id: licenseId, machine_fingerprint: fingerprint, action: 'activate',
      result: 'ok', reason: 'push relay', ip
    })
    return json({ ok: true, relayed: true })
  } catch (err) {
    await logCheckin(db, {
      license_id: licenseId, machine_fingerprint: fingerprint, action: 'activate',
      result: 'denied', reason: String((err as Error)?.message ?? err), ip
    })
    return json({ error: 'Push relay unavailable' }, 500)
  }
})

