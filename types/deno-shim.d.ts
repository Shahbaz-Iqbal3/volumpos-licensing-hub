// Minimal Deno + remote-import shims so `tsc` can typecheck the Edge Functions
// (which are really run by Deno). Not used at runtime.
//
// Only `Deno.serve`/`Deno.env` are typed precisely. The Supabase client is
// intentionally loose (`any`): the real types come from the supabase-js on Deno,
// and re-declaring its full fluent builder here would be a maintenance burden.

declare namespace Deno {
  function serve(handler: (req: Request) => Response | Promise<Response>): void
  const env: {
    get(key: string): string | undefined
  }
}

declare module 'https://esm.sh/@supabase/supabase-js@2' {
  // deno-lint-ignore no-explicit-any
  export type SupabaseClient = any
  // deno-lint-ignore no-explicit-any
  export function createClient(url: string, key: string, options?: any): SupabaseClient
}

declare module 'https://deno.land/std@0.168.0/http/server.ts' {
  export function serve(handler: (req: Request) => Response | Promise<Response>): void
}
