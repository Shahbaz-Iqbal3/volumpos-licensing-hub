import { describe, it, expect } from 'vitest'
import {
  generateKeyPair,
  signLicense,
  verifyLicenseKey,
  verifySignature,
  type LicensePayload
} from '@volumpos/license'
import {
  signLicensePayload,
  toWire,
  derivePublicKeyB64,
  addMonths,
  addDays
} from '../supabase/functions/_shared/licenseSign.ts'
import {
  decideActivation,
  resolveEntitlement,
  sourcesMatch,
  withinRenewalWindow,
  nextRenewalExpiry
} from '../supabase/functions/_shared/logic.ts'
import { generateLicenseKey, hashLicenseKey, keyLast4, normalizeKey, productTag } from '../supabase/functions/_shared/keys.ts'

const keys = generateKeyPair()

function decodePayload(payloadB64: string): string {
  return Buffer.from(payloadB64, 'base64url').toString('utf8')
}

// The hub runs on Deno and cannot import @volumpos/license. These tests prove
// its separate WebCrypto implementation produces keys the product verifier
// accepts, and that both serialize the payload identically.

describe('hub signer <-> product verifier', () => {
  it('produces a license the shared package verifies (fuzzy fingerprint)', async () => {
    const sources = { 'machine-guid': 'aaa', cpu: 'bbb', disk: 'ccc' }
    const license = await signLicensePayload(
      {
        licenseId: 'LIC-0000001',
        customerId: 'CUST-0001',
        product: 'RESTAURANT_POS',
        licenseType: 'perpetual',
        shopName: 'Demo Restaurant',
        fingerprint: 'composite-hash-value',
        sources,
        expiresAt: addDays(365).toISOString(),
        tier: '1y',
        activationLimit: 2,
        issuedAt: new Date().toISOString()
      },
      keys.privateKey
    )

    const result = verifyLicenseKey(license, keys.publicKey, {
      fingerprint: { 'machine-guid': 'aaa', cpu: 'bbb', disk: 'CHANGED' },
      product: 'RESTAURANT_POS'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.shopName).toBe('Demo Restaurant')
    expect(result.activationLimit).toBe(2)
    expect(result.payload.lid).toBe('LIC-0000001')
  })

  it('serializes the same payload identically to the package', () => {
    const input = {
      licenseId: 'LIC-0000002',
      customerId: 'CUST-0002',
      product: 'FABRIC_POS',
      licenseType: 'subscription' as const,
      shopName: 'Fabric Shop',
      fingerprint: 'fp-hash',
      sources: { cpu: 'x' },
      expiresAt: '2027-01-01T00:00:00.000Z',
      tier: 'custom',
      features: ['inventory'],
      durationMonths: 6,
      activationLimit: 1,
      issuedAt: '2026-01-01T00:00:00.000Z'
    }

    const hubWire = JSON.stringify(toWire(input))

    // The package's own mapper, via a sign/parse round trip.
    const packagePassword: LicensePayload = {
      v: 2,
      lid: input.licenseId,
      cid: input.customerId,
      product: input.product,
      type: input.licenseType,
      shop: input.shopName,
      fingerprint: input.fingerprint,
      sources: input.sources,
      expiresAt: input.expiresAt,
      tier: input.tier,
      features: input.features,
      durationMonths: input.durationMonths,
      activationLimit: input.activationLimit,
      issuedAt: input.issuedAt
    }
    const packageKey = signLicense(packagePassword, keys.privateKey)
    const packageWire = decodePayload(packageKey.split('.')[0]!)

    expect(hubWire).toBe(packageWire)
  })

  it('derives the public key from the private key', async () => {
    const derived = await derivePublicKeyB64(keys.privateKey)
    expect(derived).toBe(keys.publicKey)
  })

  it('emits a signature the package verifies directly', async () => {
    const wire = JSON.stringify(toWire({
      licenseId: 'LIC-1',
      customerId: 'CUST-1',
      product: 'RESTAURANT_POS',
      licenseType: 'perpetual',
      shopName: 'S',
      fingerprint: 'f',
      expiresAt: addDays(1).toISOString()
    }))
    const license = await signLicensePayload(
      {
        licenseId: 'LIC-1',
        customerId: 'CUST-1',
        product: 'RESTAURANT_POS',
        licenseType: 'perpetual',
        shopName: 'S',
        fingerprint: 'f',
        expiresAt: addDays(1).toISOString()
      },
      keys.privateKey
    )
    const [payloadB64, sigB64] = license.split('.')
    expect(decodePayload(payloadB64!)).toBe(wire)
    expect(
      verifySignature(
        Buffer.from(wire, 'utf8'),
        Buffer.from(sigB64!.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
        keys.publicKey
      )
    ).toBe(true)
  })
})

describe('activation decisions', () => {
  it('reissues for the same machine without consuming a seat', () => {
    const decision = decideActivation({
      fingerprint: 'fp1',
      activationLimit: 1,
      activations: [{ machine_fingerprint: 'fp1', fingerprint_sources: null, deactivated_at: null }]
    })
    expect(decision.action).toBe('reissue')
    if (decision.action !== 'reissue') return
    expect(decision.matchedFingerprint).toBe('fp1')
  })

  it('reissues on a fuzzy match and reports the stored fingerprint to rebind', () => {
    const decision = decideActivation({
      fingerprint: 'fp-new',
      fingerprintSources: { a: '1', b: '2', c: '3' },
      activationLimit: 1,
      activations: [{
        machine_fingerprint: 'fp-old',
        fingerprint_sources: { a: '1', b: '2', c: 'CHANGED' },
        deactivated_at: null
      }]
    })
    expect(decision.action).toBe('reissue')
    if (decision.action !== 'reissue') return
    // The row to update is keyed by the OLD fingerprint, not the incoming one.
    expect(decision.matchedFingerprint).toBe('fp-old')
  })

  it('grants a new seat under the limit and denies past it', () => {
    const under = decideActivation({ fingerprint: 'fp2', activationLimit: 2, activations: [
      { machine_fingerprint: 'fp1', fingerprint_sources: null, deactivated_at: null }
    ] })
    expect(under.action).toBe('new-seat')

    const over = decideActivation({ fingerprint: 'fp3', activationLimit: 1, activations: [
      { machine_fingerprint: 'fp1', fingerprint_sources: null, deactivated_at: null }
    ] })
    expect(over.action).toBe('deny')
  })

  it('ignores deactivated machines when counting seats', () => {
    const decision = decideActivation({ fingerprint: 'fp2', activationLimit: 1, activations: [
      { machine_fingerprint: 'fp1', fingerprint_sources: null, deactivated_at: '2026-01-01T00:00:00Z' }
    ] })
    expect(decision.action).toBe('new-seat')
  })

  it('fuzzy source matching requires half the recorded sources', () => {
    expect(sourcesMatch({ a: '1', b: '2' }, { a: '1', b: 'X' })).toBe(true)
    expect(sourcesMatch({ a: '1', b: '2', c: '3' }, { a: 'X', b: 'X', c: '3' })).toBe(false)
  })
})

describe('entitlement', () => {
  const now = new Date('2026-06-01T00:00:00Z')

  it('denies revoked and suspended licenses as non-billing', () => {
    for (const status of ['revoked', 'suspended']) {
      const result = resolveEntitlement({
        id: 'L', product: 'RESTAURANT_POS', licenseType: 'perpetual',
        status, activationLimit: 1, expiresAt: null, durationMonths: null
      }, now)
      expect(result.allowed).toBe(false)
      // Admin actions must not surface as a billing problem to the customer.
      if (!result.allowed) expect(result.billing).toBe(false)
    }
  })

  it('denies subscriptions that are not active as billing', () => {
    for (const subscriptionStatus of ['cancelled', 'past_due', 'paused']) {
      const result = resolveEntitlement({
        id: 'L', product: 'RESTAURANT_POS', licenseType: 'subscription',
        status: 'active', activationLimit: 1,
        expiresAt: '2026-06-10T00:00:00Z', durationMonths: 1, subscriptionStatus
      }, now)
      expect(result.allowed).toBe(false)
      if (!result.allowed) expect(result.billing).toBe(true)
    }
  })

  it('allows an active subscription within the buffer window', () => {
    const result = resolveEntitlement({
      id: 'L', product: 'RESTAURANT_POS', licenseType: 'subscription',
      status: 'active', activationLimit: 1,
      expiresAt: '2026-05-29T00:00:00Z', durationMonths: 1, subscriptionStatus: 'active'
    }, now)
    expect(result.allowed).toBe(true)
  })

  it('treats a perpetual license with no expiry as never-ending', () => {
    const result = resolveEntitlement({
      id: 'L', product: 'RESTAURANT_POS', licenseType: 'perpetual',
      status: 'active', activationLimit: 1, expiresAt: null, durationMonths: null
    }, now)
    expect(result.allowed).toBe(true)
  })

  it('flags renewal only inside the window', () => {
    expect(withinRenewalWindow('2026-06-03T00:00:00Z', 5, now)).toBe(true)
    expect(withinRenewalWindow('2026-08-01T00:00:00Z', 5, now)).toBe(false)
  })

  it('does not extend a subscription outside the renewal window', () => {
    // Regression: repeated /renew calls used to stack a billing cycle each time.
    const decision = nextRenewalExpiry({
      expiresAt: '2026-10-01T00:00:00Z',
      licenseType: 'subscription',
      billingCycleMonths: 1,
      bufferDays: 7,
      now
    })
    expect(decision.renew).toBe(false)
    expect(decision.expiresAt).toBe('2026-10-01T00:00:00Z')
  })

  it('extends a subscription one cycle plus buffer inside the window', () => {
    const decision = nextRenewalExpiry({
      expiresAt: '2026-06-03T00:00:00Z',
      licenseType: 'subscription',
      billingCycleMonths: 1,
      bufferDays: 7,
      now
    })
    expect(decision.renew).toBe(true)
    // 2026-06-03 + 1 month = 2026-07-03, + 7 days = 2026-07-10.
    expect(decision.expiresAt.slice(0, 10)).toBe('2026-07-10')
  })

  it('is idempotent on immediate retry after renewing', () => {
    const first = nextRenewalExpiry({
      expiresAt: '2026-06-03T00:00:00Z',
      licenseType: 'subscription',
      billingCycleMonths: 1,
      bufferDays: 7,
      now
    })
    expect(first.renew).toBe(true)
    const second = nextRenewalExpiry({
      expiresAt: first.expiresAt,
      licenseType: 'subscription',
      billingCycleMonths: 1,
      bufferDays: 7,
      now
    })
    expect(second.renew).toBe(false)
    expect(second.expiresAt).toBe(first.expiresAt)
  })

  it('never extends a perpetual license', () => {
    const decision = nextRenewalExpiry({
      expiresAt: '2026-06-03T00:00:00Z',
      licenseType: 'perpetual',
      billingCycleMonths: undefined,
      bufferDays: 7,
      now
    })
    expect(decision.renew).toBe(false)
  })

  it('adds calendar months', () => {
    const result = addMonths(6, new Date('2026-01-15T00:00:00Z'))
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-15')
  })
})

describe('purchase keys', () => {
  it('generates readable keys with a product tag', () => {
    const key = generateLicenseKey(productTag('FABRIC_POS'))
    expect(key).toMatch(/^POS-FABRIC-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  })

  it('never contains ambiguous characters', () => {
    for (let i = 0; i < 50; i++) {
      const key = generateLicenseKey('REST')
      expect(key.slice(11)).not.toMatch(/[ILOU01]/)
    }
  })

  it('normalizes pasted keys and hashes deterministically', async () => {
    const raw = 'POS-REST-KX7P-92MD'
    expect(normalizeKey('  pos-rest-kx7p-92md ')).toBe(raw)
    expect(await hashLicenseKey(raw)).toBe(await hashLicenseKey(' pos-rest-kx7p-92md '))
    expect(keyLast4(raw)).toBe('92MD')
  })

  it('generates unique keys', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateLicenseKey('REST')))
    expect(set.size).toBe(200)
  })
})
