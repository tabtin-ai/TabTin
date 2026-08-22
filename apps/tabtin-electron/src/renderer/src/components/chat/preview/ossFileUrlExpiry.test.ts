import { describe, expect, it } from 'vitest'
import {
  isOssFileUrlFresh,
  resolveOssFileUrl,
  resolveOssFileUrlExpiry,
} from './ossFileUrlExpiry'

describe('ossFileUrlExpiry', () => {
  const now = Date.parse('2026-07-31T10:00:00.000Z')

  it('prefers the server-resolved URL over persisted compatibility URLs', () => {
    expect(resolveOssFileUrl({
      resolved_url: 'https://oss.example/signed',
      cdn_url: 'https://cdn.example/bare',
      access_url: 'https://oss.example/bare',
    })).toBe('https://oss.example/signed')
  })

  it('refreshes a signed URL during the final minute', () => {
    const expiresAt = resolveOssFileUrlExpiry({
      access_url: 'https://oss.example/signed',
      expires_at: '2026-07-31T10:06:00.000Z',
    }, now)

    expect(isOssFileUrlFresh(expiresAt, now)).toBe(true)
    expect(isOssFileUrlFresh(expiresAt, now + 5 * 60_000)).toBe(false)
  })

  it('keeps explicitly public URLs cacheable without expiry', () => {
    const expiresAt = resolveOssFileUrlExpiry({
      access_url: 'https://cdn.example/public',
      expires_at: null,
      expires_in: null,
    }, now)

    expect(expiresAt).toBe(Number.POSITIVE_INFINITY)
    expect(isOssFileUrlFresh(expiresAt, now + 365 * 24 * 60 * 60_000)).toBe(true)
  })

  it('only caches legacy responses for five minutes', () => {
    const expiresAt = resolveOssFileUrlExpiry({
      access_url: 'https://oss.example/unknown',
    }, now)

    expect(expiresAt).toBe(now + 5 * 60_000)
  })

  it('uses the earlier relative deadline when client and server clocks differ', () => {
    const expiresAt = resolveOssFileUrlExpiry({
      access_url: 'https://oss.example/signed',
      expires_at: '2026-07-31T16:00:00.000Z',
      expires_in: 300,
    }, now)

    expect(expiresAt).toBe(now + 300_000)
  })
})
