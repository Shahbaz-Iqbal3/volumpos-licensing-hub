// Sanity-check that a hub LICENSE_PRIVATE_KEY matches the public key baked into
// the products. Run before deploying the hub.
//
//   node --experimental-strip-types scripts/verify-keypair.ts
//
// Reads LICENSE_PRIVATE_KEY from the environment, prints the derived public
// key, and compares it to the known family public key. It does NOT print the
// private key.
import { derivePublicKeyB64 } from '../supabase/functions/_shared/licenseSign.ts'

const EXPECTED = process.env.EXPECTED_PUBLIC_KEY ||
  'MCowBQYDK2VwAyEA1a/zG/WDA9gVk5e9vjCVx6sFk9TpbuPcIb/BtS5nwkM='

const privateKey = process.env.LICENSE_PRIVATE_KEY
if (!privateKey) {
  console.error('Set LICENSE_PRIVATE_KEY to the hub signing key.')
  process.exit(1)
}

const derived = await derivePublicKeyB64(privateKey)
if (!derived) {
  console.error('Could not derive a public key — is LICENSE_PRIVATE_KEY a valid PKCS#8 Ed25519 key?')
  process.exit(1)
}

console.log('Derived public key:', derived)
console.log('Expected public key:', EXPECTED)
if (derived === EXPECTED) {
  console.log('\nOK — the hub signing key matches the key baked into the products.')
} else {
  console.error('\nMISMATCH — products will reject licenses signed by this key.')
  process.exit(1)
}
