import { describe, it, expect, vi } from 'vitest'
import { timingSafeEqual } from '../supabase/functions/_shared/http.ts'
import {
  checkAdminRateLimit,
  recordAdminAuthFailure,
  MAX_FAILED_ATTEMPTS,
  ADMIN_AUTH_ACTION
} from '../supabase/functions/_shared/ratelimit.ts'

describe('timingSafeEqual', () => {
  it('accepts identical strings', () => {
    expect(timingSafeEqual('correct-horse', 'correct-horse')).toBe(true)
  })

  it('rejects different strings of the same length', () => {
    expect(timingSafeEqual('correct-horse', 'correct-horsf')).toBe(false)
  })

  it('rejects a prefix', () => {
    expect(timingSafeEqual('secret', 'sec')).toBe(false)
  })

  it('rejects an empty candidate', () => {
    expect(timingSafeEqual('', 'secret')).toBe(false)
  })

  it('handles unicode without throwing', () => {
    expect(timingSafeEqual('کلمه', 'کلمه')).toBe(true)
    expect(timingSafeEqual('کلمه', 'کلمہ')).toBe(false)
  })
})

// A tiny fake of the Supabase query builder used by the rate limiter. It
// records the filters applied and returns a preset count, so the decision logic
// is testable without a database.
function fakeClient(count: number | null, error: unknown = null) {
  const filters: Array<[string, unknown]> = []
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push([column, value])
      return builder
    },
    gte: (column: string, value: unknown) => {
      filters.push([column, value])
      return builder
    },
    insert: vi.fn(async () => ({ data: null, error: null })),
    then: (resolve: (value: { count: number | null; error: unknown }) => unknown) =>
      Promise.resolve(resolve({ count, error }))
  }
  return { client: { from: () => builder } as never, filters, builder }
}

describe('checkAdminRateLimit', () => {
  it('allows a request with no IP (cannot attribute attempts)', async () => {
    const { client } = fakeClient(999)
    expect(await checkAdminRateLimit(client, null)).toEqual({ allowed: true })
  })

  it('allows while under the limit', async () => {
    const { client } = fakeClient(MAX_FAILED_ATTEMPTS - 1)
    expect(await checkAdminRateLimit(client, '1.2.3.4')).toEqual({ allowed: true })
  })

  it('blocks at the limit and reports the retry window', async () => {
    const { client } = fakeClient(MAX_FAILED_ATTEMPTS)
    const result = await checkAdminRateLimit(client, '1.2.3.4')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.retryAfterMinutes).toBeGreaterThan(0)
  })

  it('scopes the count to the admin-auth action for this IP', async () => {
    const { client, filters } = fakeClient(0)
    await checkAdminRateLimit(client, '9.9.9.9')
    expect(filters).toContainEqual(['action', ADMIN_AUTH_ACTION])
    expect(filters).toContainEqual(['result', 'denied'])
    expect(filters).toContainEqual(['ip', '9.9.9.9'])
  })

  it('fails open when the query errors, so an outage cannot lock the operator out', async () => {
    const { client } = fakeClient(null, { message: 'db down' })
    expect(await checkAdminRateLimit(client, '1.2.3.4')).toEqual({ allowed: true })
  })
})

describe('recordAdminAuthFailure', () => {
  it('writes a denied admin-auth row', async () => {
    const { client, builder } = fakeClient(0)
    await recordAdminAuthFailure(client, '5.5.5.5', 'bad admin secret')
    expect((builder.insert as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({
      action: ADMIN_AUTH_ACTION,
      result: 'denied',
      reason: 'bad admin secret',
      ip: '5.5.5.5'
    })
  })

  it('never throws, even when the insert rejects', async () => {
    const client = {
      from: () => ({
        insert: async () => {
          throw new Error('db down')
        }
      })
    } as never
    await expect(recordAdminAuthFailure(client, '5.5.5.5', 'x')).resolves.toBeUndefined()
  })
})
