// POST /ocr — OCR proxy with per-license scan quota.
//
// Body: { license_id, machine_fingerprint, image_base64? }
// First OCR_FREE_SCANS_PER_MONTH scans per calendar month are free; beyond
// that the license must carry the ocr-addon feature flag.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { json, preflight, methodNotAllowed, clientIp } from '../_shared/http.ts'
import { serviceClient, logCheckin } from '../_shared/db.ts'
import { OCR_FREE_SCANS_PER_MONTH, FEATURE_OCR_SCANS, FEATURE_OCR_ADDON } from '../_shared/constants.ts'

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

    if (!licenseId || !fingerprint) {
      return json({ error: 'license_id and machine_fingerprint are required' }, 400)
    }

    const { data: license, error } = await db
      .from('licenses')
      .select('id, product, features, status')
      .eq('id', licenseId)
      .maybeSingle()
    if (error || !license) {
      return json({ error: 'License not recognised' }, 404)
    }
    const features: string[] = license.features ?? []

    if (!features.includes(FEATURE_OCR_SCANS)) {
      return json({ error: 'OCR scans are not enabled for this license' }, 403)
    }

    const month = new Date().toISOString().slice(0, 7) // 'YYYY-MM'
    const { data: usage } = await db
      .from('ocr_scan_usage')
      .select('scan_count')
      .eq('license_id', licenseId)
      .eq('month', month)
      .maybeSingle()
    const used = usage?.scan_count ?? 0
    const hasAddon = features.includes(FEATURE_OCR_ADDON)

    if (used >= OCR_FREE_SCANS_PER_MONTH && !hasAddon) {
      await logCheckin(db, {
        license_id: licenseId, machine_fingerprint: fingerprint, action: 'activate',
        result: 'denied', reason: 'ocr quota exceeded', ip
      })
      return json({ ok: false, quotaExceeded: true, used, limit: OCR_FREE_SCANS_PER_MONTH }, 402)
    }

    // --- OCR proxy call goes here: image_base64 -> OCR provider -> text ---
    const ocrText = '' // TODO: wire to OCR provider

    await db.from('ocr_scan_usage').upsert({
      license_id: licenseId,
      month,
      scan_count: used + 1,
      updated_at: new Date().toISOString()
    })

    await logCheckin(db, {
      license_id: licenseId, machine_fingerprint: fingerprint, action: 'activate',
      result: 'ok', reason: 'ocr scan', ip
    })
    return json({ ok: true, text: ocrText, used: used + 1, limit: OCR_FREE_SCANS_PER_MONTH, addon: hasAddon })
  } catch (err) {
    await logCheckin(db, {
      license_id: licenseId, machine_fingerprint: fingerprint, action: 'activate',
      result: 'denied', reason: String((err as Error)?.message ?? err), ip
    })
    return json({ error: 'OCR unavailable' }, 500)
  }
})
