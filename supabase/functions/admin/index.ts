// POST /admin
//
// Internal admin API, gated by the `x-admin-secret` header (LICENSE_ADMIN_SECRET).
// The minimal admin panel calls this. Actions:
//
//   create-customer      { name, phone?, email?, notes? }        -> customer id
//   list-customers       {}                                      -> customers
//   create-license       { customer_id, product, license_type,   -> license + raw key
//                          tier?, duration_months?, features?,
//                          activation_limit?, expires_at?,
//                          subscription_id? }
//   list-licenses        { customer_id? }
//   set-license-status   { license_id, status }
//   set-activation-limit { license_id, activation_limit }
//   create-subscription  { customer_id, product, billing_cycle_months,
//                          price_minor?, currency?, next_billing_date? }
//   set-subscription     { subscription_id, status?, next_billing_date? }
//   stats                {}
//
// The raw purchase key is returned exactly once, at `create-license`. Only its
// hash and last four characters are stored.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { json, preflight, methodNotAllowed, clientIp, timingSafeEqual } from '../_shared/http.ts'
import { serviceClient, adminSecret, logCheckin } from '../_shared/db.ts'
import { checkAdminRateLimit, recordAdminAuthFailure } from '../_shared/ratelimit.ts'
import { generateLicenseKey, hashLicenseKey, keyLast4, productTag } from '../_shared/keys.ts'
import { addMonths } from '../_shared/licenseSign.ts'
import { isKnownProduct, DEFAULT_ACTIVATION_LIMIT } from '../_shared/constants.ts'

/** Term tiers mapped to days. A tier is only used when no explicit date is given. */
async function nextId(db: ReturnType<typeof serviceClient>, prefix: string, counter: string, width: number): Promise<string> {
  const { data, error } = await db.rpc('next_id', { prefix, counter, width })
  if (error || !data) throw new Error(error?.message || 'id generation failed')
  return data as string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight(req)
  if (req.method !== 'POST') return methodNotAllowed(req)

  const ip = clientIp(req)
  const db = serviceClient()

  // Check the secret FIRST. Throttling is only applied to failures, so a valid
  // operator can never be locked out by someone else's attempts from the same
  // (possibly shared, possibly NAT'd) IP.
  const secret = adminSecret()
  const provided = req.headers.get('x-admin-secret') ?? ''
  if (!secret || !timingSafeEqual(provided, secret)) {
    const limit = await checkAdminRateLimit(db, ip)
    if (!limit.allowed) {
      return json(
        { error: `Too many failed attempts. Try again in ${limit.retryAfterMinutes} minutes.` },
        429,
        req
      )
    }
    await recordAdminAuthFailure(db, ip, 'bad admin secret')
    return json({ error: 'Forbidden' }, 403, req)
  }

  // Bind the request so every response carries the correct CORS origin
  // without threading `req` through each return.
  const respond = (body: unknown, status = 200): Response => json(body, status, req)

  try {
    const body: any = await req.json().catch(() => null)
    const action = typeof body?.action === 'string' ? body.action : ''

    switch (action) {
      case 'create-customer': {
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) return respond({ error: 'name is required' }, 400)
        const id = await nextId(db, 'CUST-', 'customer', 4)
        const { error } = await db.from('customers').insert({
          id,
          name,
          phone: body.phone ?? null,
          email: body.email ?? null,
          notes: body.notes ?? null
        })
        if (error) return respond({ error: error.message }, 500)
        await logCheckin(db, { action: 'admin', result: 'ok', reason: `create-customer ${id}`, ip })
        return respond({ ok: true, customer_id: id })
      }

      case 'list-customers': {
        const { data, error } = await db.from('customers').select('*').order('created_at', { ascending: false })
        if (error) return respond({ error: error.message }, 500)
        const customers = []
        for (const customer of data ?? []) {
          const { data: licenses } = await db.from('licenses').select('*').eq('customer_id', customer.id)
          const { data: subscriptions } = await db.from('subscriptions').select('*').eq('customer_id', customer.id)
          customers.push({ ...customer, licenses: licenses ?? [], subscriptions: subscriptions ?? [] })
        }
        return respond({ ok: true, customers })
      }

      case 'issue-license-bundle': {
        const customerName = typeof body.customer_name === 'string' ? body.customer_name.trim() : ''
        const existingCustomerId = typeof body.customer_id === 'string' ? body.customer_id.trim() : ''
        const product = typeof body.product === 'string' ? body.product : ''
        const licenseType = 'subscription' as const
        if ((!customerName && !existingCustomerId) || !product) return respond({ error: 'Select an existing customer or provide a new customer name, and choose a product' }, 400)
        if (!isKnownProduct(product)) return respond({ error: `Unknown product ${product}` }, 400)

        const activationLimit = Math.max(1, Math.floor(Number(body.activation_limit) || DEFAULT_ACTIVATION_LIMIT))
        const features = Array.isArray(body.features) ? body.features.filter((f: unknown) => typeof f === 'string') : []
        const tier = typeof body.tier === 'string' && body.tier ? body.tier : null
        const durationMonths = Number.isFinite(Number(body.duration_months)) && Number(body.duration_months) > 0
          ? Math.floor(Number(body.duration_months))
          : null
        const billingCycleMonths = Math.max(1, Math.floor(Number(body.billing_cycle_months) || durationMonths || 1))
        const autoRenew = body.auto_renew !== false
        const autoRenewUntil = typeof body.auto_renew_until === 'string' && body.auto_renew_until ? body.auto_renew_until : null

        let customerId: string | null = existingCustomerId || null
        let createdCustomer = false
        let subscriptionId: string | null = null
        try {
          if (customerId) {
            const { data: existingCustomer, error: customerError } = await db.from('customers').select('id').eq('id', customerId).maybeSingle()
            if (customerError) throw new Error(customerError.message)
            if (!existingCustomer) return respond({ error: 'Selected customer was not found' }, 404)
          } else {
            customerId = await nextId(db, 'CUST-', 'customer', 4)
            const customerInsert = await db.from('customers').insert({
              id: customerId,
              name: customerName,
              phone: typeof body.phone === 'string' ? body.phone.trim() || null : null,
              email: typeof body.email === 'string' ? body.email.trim() || null : null,
              notes: typeof body.notes === 'string' ? body.notes.trim() || null : null
            })
            if (customerInsert.error) throw new Error(customerInsert.error.message)
            createdCustomer = true
          }

          {
            const subscription = await db.from('subscriptions').insert({
              customer_id: customerId,
              product,
              status: 'active',
              billing_cycle_months: billingCycleMonths,
              price_minor: Number.isFinite(Number(body.price_minor)) ? Math.floor(Number(body.price_minor)) : null,
              currency: typeof body.currency === 'string' ? body.currency : 'PKR',
              next_billing_date: typeof body.next_billing_date === 'string' ? body.next_billing_date : null,
              auto_renew: autoRenew,
              auto_renew_until: autoRenewUntil
            }).select('id').maybeSingle()
            if (subscription.error || !subscription.data?.id) throw new Error(subscription.error?.message || 'subscription creation failed')
            subscriptionId = subscription.data.id
          }

          let expiresAt: string | null = null
          expiresAt = addMonths(billingCycleMonths).toISOString()

          const licenseId = await nextId(db, 'LIC-', 'license', 7)
          const rawKey = generateLicenseKey(productTag(product))
          const keyHash = await hashLicenseKey(rawKey)
          const licenseInsert = await db.from('licenses').insert({
            id: licenseId,
            customer_id: customerId,
            product,
            license_type: licenseType,
            tier,
            duration_months: durationMonths || billingCycleMonths,
            features,
            activation_limit: activationLimit,
            status: 'unactivated',
            key_hash: keyHash,
            key_last4: keyLast4(rawKey),
            expires_at: expiresAt,
            subscription_id: subscriptionId
          })
          if (licenseInsert.error) throw new Error(licenseInsert.error.message)

          await logCheckin(db, { action: 'admin', result: 'ok', reason: `issue-license-bundle ${licenseId}`, ip })
          return respond({
            ok: true,
            customer_id: customerId,
            subscription_id: subscriptionId,
            license_id: licenseId,
            license_key: rawKey,
            expires_at: expiresAt,
            note: 'This key is shown once. Store it safely and give it to the customer.'
          })
        } catch (error) {
          // Best-effort rollback keeps a failed one-click issue from leaving
          // orphan customer/subscription rows behind.
          if (subscriptionId) await db.from('subscriptions').delete().eq('id', subscriptionId)
          if (customerId && createdCustomer) await db.from('customers').delete().eq('id', customerId)
          return respond({ error: String((error as Error)?.message || error) }, 500)
        }
      }

      case 'update-customer': {
        const customerId = typeof body.customer_id === 'string' ? body.customer_id : ''
        if (!customerId) return respond({ error: 'customer_id is required' }, 400)
        const update: Record<string, unknown> = {}
        for (const field of ['name', 'phone', 'email', 'notes']) {
          if (body[field] !== undefined) update[field] = body[field] === '' ? null : body[field]
        }
        if (!Object.keys(update).length) return respond({ error: 'No fields to update' }, 400)
        const { error } = await db.from('customers').update(update).eq('id', customerId)
        if (error) return respond({ error: error.message }, 500)
        return respond({ ok: true })
      }

      case 'delete-customer': {
        const customerId = typeof body.customer_id === 'string' ? body.customer_id : ''
        if (!customerId) return respond({ error: 'customer_id is required' }, 400)
        const { count } = await db.from('licenses').select('*', { count: 'exact', head: true }).eq('customer_id', customerId)
        if ((count ?? 0) > 0) return respond({ error: 'Delete or reassign this customer\'s licenses first.' }, 409)
        const { error } = await db.from('customers').delete().eq('id', customerId)
        if (error) return respond({ error: error.message }, 500)
        return respond({ ok: true })
      }

      case 'create-license': {
        const customerId = typeof body.customer_id === 'string' ? body.customer_id : ''
        const product = typeof body.product === 'string' ? body.product : ''
        const licenseType = 'subscription' as const
        if (!customerId || !product) return respond({ error: 'customer_id and product are required' }, 400)
        if (!isKnownProduct(product)) return respond({ error: `Unknown product ${product}` }, 400)

        const activationLimit = Math.max(1, Math.floor(Number(body.activation_limit) || DEFAULT_ACTIVATION_LIMIT))
        const features = Array.isArray(body.features) ? body.features.filter((f: unknown) => typeof f === 'string') : []
        const tier = typeof body.tier === 'string' ? body.tier : null
        const durationMonths = Number.isFinite(Number(body.duration_months)) ? Math.floor(Number(body.duration_months)) : null
        const subscriptionId = typeof body.subscription_id === 'string' ? body.subscription_id : ''
        if (!subscriptionId) return respond({ error: 'subscription_id is required; use issue-license-bundle for new issuance' }, 400)
        const { data: subscription, error: subscriptionError } = await db
          .from('subscriptions')
          .select('id, customer_id, product')
          .eq('id', subscriptionId)
          .eq('customer_id', customerId)
          .maybeSingle()
        if (subscriptionError) return respond({ error: subscriptionError.message }, 500)
        if (!subscription || subscription.product !== product) return respond({ error: 'subscription_id must belong to the customer and product' }, 400)

        // Existing perpetual rows remain valid, but every newly-created row is
        // subscription-backed and receives a finite initial billing term.
        let expiresAt: string | null = null
        if (typeof body.expires_at === 'string' && body.expires_at) {
          const parsed = new Date(body.expires_at)
          if (isNaN(parsed.getTime())) return respond({ error: 'expires_at is not a valid date' }, 400)
          expiresAt = parsed.toISOString()
        } else if (licenseType === 'subscription') {
          const months = durationMonths ?? 1
          expiresAt = addMonths(months).toISOString()
        }

        const id = await nextId(db, 'LIC-', 'license', 7)
        const rawKey = generateLicenseKey(productTag(product))
        const keyHash = await hashLicenseKey(rawKey)

        const { error } = await db.from('licenses').insert({
          id,
          customer_id: customerId,
          product,
          license_type: licenseType,
          tier,
          duration_months: durationMonths,
          features,
          activation_limit: activationLimit,
          status: 'unactivated',
          key_hash: keyHash,
          key_last4: keyLast4(rawKey),
          expires_at: expiresAt,
          subscription_id: subscriptionId
        })
        if (error) return respond({ error: error.message }, 500)

        await logCheckin(db, { action: 'admin', result: 'ok', reason: `create-license ${id}`, ip })
        return respond({
          ok: true,
          license_id: id,
          license_key: rawKey,
          note: 'This key is shown once. Store it safely and give it to the customer.'
        })
      }

      case 'list-licenses': {
        let query = db.from('licenses').select('*').order('issued_at', { ascending: false })
        if (typeof body.customer_id === 'string') query = query.eq('customer_id', body.customer_id)
        const { data, error } = await query
        if (error) return respond({ error: error.message }, 500)
        return respond({ ok: true, licenses: data ?? [] })
      }

      case 'update-license': {
        const licenseId = typeof body.license_id === 'string' ? body.license_id : ''
        if (!licenseId) return respond({ error: 'license_id is required' }, 400)
        const { data: license } = await db.from('licenses').select('subscription_id').eq('id', licenseId).maybeSingle()
        if (license?.subscription_id) return respond({ error: 'Subscription-backed licenses are controlled by their subscription' }, 409)
        const update: Record<string, unknown> = {}
        if (typeof body.status === 'string') update.status = body.status
        if (body.activation_limit !== undefined) update.activation_limit = Math.max(1, Math.floor(Number(body.activation_limit) || 1))
        if (body.expires_at !== undefined) update.expires_at = body.expires_at || null
        if (body.notes !== undefined) update.notes = body.notes || null
        if (!Object.keys(update).length) return respond({ error: 'No fields to update' }, 400)
        const { error } = await db.from('licenses').update(update).eq('id', licenseId)
        if (error) return respond({ error: error.message }, 500)
        return respond({ ok: true })
      }

      case 'delete-license': {
        const licenseId = typeof body.license_id === 'string' ? body.license_id : ''
        if (!licenseId) return respond({ error: 'license_id is required' }, 400)
        const { data: license } = await db.from('licenses').select('subscription_id').eq('id', licenseId).maybeSingle()
        if (license?.subscription_id) return respond({ error: 'Delete the subscription instead; subscription-backed licenses are managed automatically' }, 409)
        const { error } = await db.from('licenses').delete().eq('id', licenseId)
        if (error) return respond({ error: error.message }, 500)
        return respond({ ok: true })
      }

      case 'set-license-status': {
        const licenseId = typeof body.license_id === 'string' ? body.license_id : ''
        const status = typeof body.status === 'string' ? body.status : ''
        const allowed = ['unactivated', 'active', 'suspended', 'expired', 'revoked']
        if (!licenseId || !allowed.includes(status)) return respond({ error: 'license_id and a valid status are required' }, 400)
        const { data: license } = await db.from('licenses').select('subscription_id').eq('id', licenseId).maybeSingle()
        if (license?.subscription_id) return respond({ error: 'Subscription-backed licenses are controlled by their subscription' }, 409)
        const { error } = await db.from('licenses').update({ status }).eq('id', licenseId)
        if (error) return respond({ error: error.message }, 500)
        return respond({ ok: true })
      }

      case 'set-activation-limit': {
        const licenseId = typeof body.license_id === 'string' ? body.license_id : ''
        const limit = Math.max(1, Math.floor(Number(body.activation_limit) || 1))
        if (!licenseId) return respond({ error: 'license_id is required' }, 400)
        const { data: license } = await db.from('licenses').select('subscription_id').eq('id', licenseId).maybeSingle()
        if (license?.subscription_id) return respond({ error: 'Subscription-backed licenses are controlled by their subscription' }, 409)
        const { error } = await db.from('licenses').update({ activation_limit: limit }).eq('id', licenseId)
        if (error) return respond({ error: error.message }, 500)
        return respond({ ok: true })
      }

      case 'create-subscription': {
        const customerId = typeof body.customer_id === 'string' ? body.customer_id : ''
        const product = typeof body.product === 'string' ? body.product : ''
        const months = Math.floor(Number(body.billing_cycle_months))
        if (!customerId || !product || !Number.isFinite(months) || months <= 0) {
          return respond({ error: 'customer_id, product and billing_cycle_months are required' }, 400)
        }
        const { data, error } = await db
          .from('subscriptions')
          .insert({
            customer_id: customerId,
            product,
            status: 'active',
            billing_cycle_months: months,
            price_minor: Number.isFinite(Number(body.price_minor)) ? Math.floor(Number(body.price_minor)) : null,
            currency: typeof body.currency === 'string' ? body.currency : 'PKR',
            next_billing_date: typeof body.next_billing_date === 'string' ? body.next_billing_date : null,
            auto_renew: body.auto_renew !== false,
            auto_renew_until: typeof body.auto_renew_until === 'string' && body.auto_renew_until ? body.auto_renew_until : null
          })
          .select('id')
          .maybeSingle()
        if (error) return respond({ error: error.message }, 500)
        return respond({ ok: true, subscription_id: data?.id })
      }

      case 'list-subscriptions': {
        let query = db.from('subscriptions').select('*').order('created_at', { ascending: false })
        if (typeof body.customer_id === 'string') query = query.eq('customer_id', body.customer_id)
        const { data, error } = await query
        if (error) return respond({ error: error.message }, 500)
        return respond({ ok: true, subscriptions: data ?? [] })
      }

      case 'set-subscription': {
        const subscriptionId = typeof body.subscription_id === 'string' ? body.subscription_id : ''
        if (!subscriptionId) return respond({ error: 'subscription_id is required' }, 400)
        const update: Record<string, unknown> = {}
        const statuses = ['active', 'past_due', 'cancelled', 'paused']
        if (typeof body.status === 'string') {
          if (!statuses.includes(body.status)) return respond({ error: 'Invalid subscription status' }, 400)
          update.status = body.status
        }
        if (typeof body.next_billing_date === 'string') update.next_billing_date = body.next_billing_date
        if (body.status === 'cancelled') update.cancelled_at = new Date().toISOString()
        const { error } = await db.from('subscriptions').update(update).eq('id', subscriptionId)
        if (error) return respond({ error: error.message }, 500)
        return respond({ ok: true })
      }

      case 'update-subscription': {
        const subscriptionId = typeof body.subscription_id === 'string' ? body.subscription_id : ''
        if (!subscriptionId) return respond({ error: 'subscription_id is required' }, 400)
        const update: Record<string, unknown> = {}
        if (typeof body.status === 'string') {
          if (!['active', 'past_due', 'cancelled', 'paused'].includes(body.status)) return respond({ error: 'Invalid subscription status' }, 400)
          update.status = body.status
        }
        if (body.billing_cycle_months !== undefined) update.billing_cycle_months = Math.max(1, Math.floor(Number(body.billing_cycle_months) || 1))
        if (body.price_minor !== undefined) update.price_minor = body.price_minor === '' ? null : Math.floor(Number(body.price_minor))
        if (body.next_billing_date !== undefined) update.next_billing_date = body.next_billing_date || null
        if (body.auto_renew !== undefined) update.auto_renew = body.auto_renew !== false
        if (body.auto_renew_until !== undefined) update.auto_renew_until = body.auto_renew_until || null
        if (body.currency !== undefined) update.currency = body.currency || 'PKR'
        if (body.status === 'cancelled') update.cancelled_at = new Date().toISOString()
        if (body.status === 'active') update.cancelled_at = null
        if (!Object.keys(update).length) return respond({ error: 'No fields to update' }, 400)
        const { error } = await db.from('subscriptions').update(update).eq('id', subscriptionId)
        if (error) return respond({ error: error.message }, 500)
        return respond({ ok: true })
      }

      case 'delete-subscription': {
        const subscriptionId = typeof body.subscription_id === 'string' ? body.subscription_id : ''
        if (!subscriptionId) return respond({ error: 'subscription_id is required' }, 400)
        const { count } = await db.from('licenses').select('*', { count: 'exact', head: true }).eq('subscription_id', subscriptionId)
        if ((count ?? 0) > 0) return respond({ error: 'This subscription has linked licenses; cancel it instead of deleting it.' }, 409)
        const { error } = await db.from('subscriptions').delete().eq('id', subscriptionId)
        if (error) return respond({ error: error.message }, 500)
        return respond({ ok: true })
      }

      case 'stats': {
        const [{ count: customers }, { count: licenses }, { count: activeLicenses }, { count: subscriptions }] = await Promise.all([
          db.from('customers').select('*', { count: 'exact', head: true }),
          db.from('licenses').select('*', { count: 'exact', head: true }),
          db.from('licenses').select('*', { count: 'exact', head: true }).eq('status', 'active'),
          db.from('subscriptions').select('*', { count: 'exact', head: true }).eq('status', 'active')
        ])
        const { data: byProduct } = await db.from('licenses').select('product')
        const productCounts: Record<string, number> = {}
        for (const row of byProduct ?? []) {
          productCounts[row.product] = (productCounts[row.product] || 0) + 1
        }
        return respond({
          ok: true,
          customers: customers ?? 0,
          licenses: licenses ?? 0,
          active_licenses: activeLicenses ?? 0,
          active_subscriptions: subscriptions ?? 0,
          by_product: productCounts
        })
      }

      default:
        return respond({ error: `Unknown action: ${action || '(none)'}` }, 400)
    }
  } catch (err) {
    return respond({ error: 'Admin request failed', detail: String((err as Error)?.message ?? err) }, 500)
  }
})
