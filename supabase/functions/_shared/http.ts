// CORS + JSON response helpers shared by every hub Edge Function.

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  // x-admin-secret is sent by the admin panel and by /verify. It must be listed
  // here or the browser's preflight rejects the request before it is sent.
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store'
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

export function preflight(): Response {
  return new Response(null, { headers: corsHeaders })
}

export function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { ...corsHeaders, Allow: 'POST, OPTIONS', 'Content-Type': 'application/json' }
  })
}

/** The client's IP, for the check-in log. Best-effort only. */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || null
}
