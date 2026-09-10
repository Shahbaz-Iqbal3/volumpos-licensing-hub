// WebCrypto Ed25519 signer for the VolumPOS license wire format.
//
// This mirrors `@volumpos/license`'s `toWire()` + `signLicense()`. It exists as
// a separate, dependency-free implementation because Edge Functions run on Deno
// and cannot import the Node build. The two implementations are kept honest by
// `test/crossCompat.test.ts`, which signs here and verifies with the package.
//
// Wire shape (compact keys, legacy-compatible):
//   m=machine hash  s=shop  e=expiry  t=tier  c=seat count
//   v=lid  lid=customer license id  cid=customer id  p=product  ty=type
//   fp=per-source fingerprint map  f=features  dm=duration months
//   al=activation limit  ia=issued at
import { bytesToBase64Url, base64ToBytes, base64UrlToBytes, textToBytes } from './encoding.ts'

export type LicenseType = 'perpetual' | 'subscription'

export type FingerprintSources = Record<string, string>

export type LicensePayloadInput = {
  licenseId: string
  customerId: string
  product: string
  licenseType: LicenseType
  shopName: string
  /** Composite fingerprint hash. */
  fingerprint: string
  /** Per-source hashes, enables fuzzy matching. */
  sources?: FingerprintSources
  expiresAt: string
  tier?: string
  features?: string[]
  durationMonths?: number
  activationLimit?: number
  seats?: number
  issuedAt?: string
  version?: number
}

/** Mirror of the package's `toWire`, including key insertion order. */
export function toWire(input: LicensePayloadInput): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    m: input.fingerprint,
    s: input.shopName,
    e: input.expiresAt
  }
  const version = input.version ?? 2
  if (version !== 1) wire.v = version
  if (input.licenseId) wire.lid = input.licenseId
  if (input.customerId) wire.cid = input.customerId
  if (input.product) wire.p = input.product
  if (input.licenseType) wire.ty = input.licenseType
  if (input.tier) wire.t = input.tier
  if (input.sources && Object.keys(input.sources).length > 0) wire.fp = input.sources
  if (input.features && input.features.length > 0) wire.f = input.features
  if (input.durationMonths !== undefined) wire.dm = input.durationMonths
  if (input.activationLimit !== undefined) wire.al = input.activationLimit
  if (input.seats !== undefined) wire.c = input.seats
  if (input.issuedAt) wire.ia = input.issuedAt
  return wire
}

/**
 * Sign a license payload. `privateKeyB64` is PKCS#8 DER base64 — the same value
 * stored in the hub's `LICENSE_PRIVATE_KEY` secret and in `license-keys.json`.
 */
export async function signLicensePayload(
  input: LicensePayloadInput,
  privateKeyB64: string
): Promise<string> {
  const payloadJson = JSON.stringify(toWire(input))
  const key = await crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(privateKeyB64),
    { name: 'Ed25519' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('Ed25519', key, textToBytes(payloadJson))
  return `${bytesToBase64Url(textToBytes(payloadJson))}.${bytesToBase64Url(new Uint8Array(signature))}`
}

/**
 * Derive the SPKI public key (base64) from a PKCS#8 Ed25519 private key,
 * without node:crypto. The trailing 32 bytes of an Ed25519 PKCS#8 key are the
 * raw public key; wrapping them in the fixed SPKI header yields exactly the
 * format the products embed. Useful for sanity-checking that a hub's
 * LICENSE_PRIVATE_KEY matches the public key baked into the builds.
 */
export async function derivePublicKeyB64(privateKeyB64: string): Promise<string | null> {
  try {
    // Validate the key by importing it, then read the raw public bytes.
    const key = await crypto.subtle.importKey(
      'pkcs8',
      base64ToBytes(privateKeyB64),
      { name: 'Ed25519' },
      true,
      ['sign']
    )
    const jwk = await crypto.subtle.exportKey('jwk', key)
    if (!jwk.x) return null
    const rawPublic = base64UrlToBytes(jwk.x)
    if (rawPublic.length !== 32) return null

    // RFC 8410 SPKI header for Ed25519 (12 bytes) + the 32 raw key bytes.
    const header = new Uint8Array([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
      0x70, 0x03, 0x21, 0x00
    ])
    const spki = new Uint8Array(header.length + rawPublic.length)
    spki.set(header, 0)
    spki.set(rawPublic, header.length)

    let binary = ''
    for (const byte of spki) binary += String.fromCharCode(byte)
    return btoa(binary)
  } catch {
    return null
  }
}

/** Build a `sourceHash` map from a client-supplied per-source fingerprint.
 *  The client already hashes each source; the hub only validates shape. */
export function sanitizeSources(value: unknown): FingerprintSources | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: FingerprintSources = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === 'string' && typeof val === 'string' && val.length > 0) {
      out[key] = val
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export { addMonths, addDays } from './logic.ts'
