// CORS + JSON response helpers shared by every hub Edge Function.

/**
 * Allowed origins for browser callers.
 *
 * `ADMIN_ALLOWED_ORIGIN` (comma-separated) narrows CORS to the admin panel's
 * origin. When unset, CORS stays open — the products do not need CORS at all
 * (they call from the main process, not a browser), so an open default only
 * affects the admin panel and is safe in development.
 *
 * CORS is a browser-side control only: it stops a *website* from calling the
 * hub, not a script. The admin secret is what actually protects /admin.
 */
function allowedOrigin(req: Request): string {
  const configured = (Deno.env.get('ADMIN_ALLOWED_ORIGIN') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  const requestOrigin = req.headers.get('origin') ?? ''
  if (configured.length === 0) return '*' // open (development)
  if (requestOrigin && configured.includes(requestOrigin)) return requestOrigin
  // Disallowed origin: echo a non-matching value so the browser blocks it.
  return configured[0]!
}

export function corsHeaders(req?: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': req ? allowedOrigin(req) : '*',
    // x-admin-secret is sent by the admin panel and by /verify. It must be listed
    // here or the browser's preflight rejects the request before it is sent.
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Cache-Control': 'no-store'
  }
}

export function json(body: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' }
  })
}

export function preflight(req: Request): Response {
  return new Response(null, { headers: corsHeaders(req) })
}

export function methodNotAllowed(req?: Request): Response {
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { ...corsHeaders(req), Allow: 'POST, OPTIONS', 'Content-Type': 'application/json' }
  })
}

/** The client's IP, for the check-in log. Best-effort only. */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || null
}

/**
 * Constant-time string comparison, so a wrong admin secret cannot be recovered
 * by measuring response time. Length is compared first (that leaks only the
 * length, which is not secret enough to matter) and the bytes are then folded
 * together without an early exit.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}
