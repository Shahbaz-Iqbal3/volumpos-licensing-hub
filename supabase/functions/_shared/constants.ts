/** Extra days added to a subscription license beyond its billing cycle, so a
 *  customer who is offline at renewal time keeps working through the gap. */
export const SUBSCRIPTION_BUFFER_DAYS = 5

/** Default machines per license when the license row does not say. */
export const DEFAULT_ACTIVATION_LIMIT = 1

export const PRODUCTS = ['FABRIC_POS', 'RESTAURANT_POS'] as const

export const PRODUCT_FEATURES: Record<(typeof PRODUCTS)[number], readonly string[]> = {
  // Only implemented and production-ready features belong here. Features under
  // development must not be selectable or accepted by license issuance.
  FABRIC_POS: ['custom-orders', 'a4-printing'],
  RESTAURANT_POS: ['multi_branch']
}

export function isKnownFeature(product: string, feature: string): boolean {
  return (PRODUCT_FEATURES[product as keyof typeof PRODUCT_FEATURES] ?? []).includes(feature)
}

/** Products the hub will issue for. */
export function isKnownProduct(product: string): boolean {
  return (PRODUCTS as readonly string[]).includes(product)
}

/** Fraction of fingerprint sources that must match on re-activation. Mirrors
 *  the client package: half, rounded up, minimum 1. */
export function requiredSourceMatches(count: number): number {
  return Math.max(1, Math.ceil(count * 0.5))
}
