// Purchase-key generation and hashing.
//
// The raw purchase key is shown to the operator exactly once, at issuance. The
// database stores only its SHA-256 hash (for lookup) plus the last 4 characters
// (for support). This means a database leak does not expose usable keys.

import { sha256Hex } from './encoding.ts'

// Crockford-style alphabet: no I, L, O, U, so keys are safe to read aloud.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'

export function randomSegment(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}

/**
 * `POS-<PRODUCT>-<4>-<4>`, e.g. `POS-FABRIC-KX7P-92MD`.
 * `productTag` is a short human tag, not the full product id.
 */
export function generateLicenseKey(productTag: string): string {
  const tag = productTag.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return `POS-${tag}-${randomSegment(4)}-${randomSegment(4)}`
}

export async function hashLicenseKey(rawKey: string): Promise<string> {
  return sha256Hex(normalizeKey(rawKey))
}

export function keyLast4(rawKey: string): string {
  return normalizeKey(rawKey).slice(-4)
}

/** Uppercase, trim, and collapse whitespace so a pasted key still matches. */
export function normalizeKey(rawKey: string): string {
  return rawKey.trim().toUpperCase().replace(/\s+/g, '')
}

/** Short product tag used inside a purchase key. */
export function productTag(product: string): string {
  switch (product) {
    case 'FABRIC_POS':
      return 'FABRIC'
    case 'RESTAURANT_POS':
      return 'REST'
    default:
      return product.replace(/_POS$/, '').replace(/_/g, '').slice(0, 8) || 'POS'
  }
}
