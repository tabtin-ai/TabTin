import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertExportResponseOk,
  mapExportDownloadError,
} from '../exportDownload'

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  },
}))

describe('assertExportResponseOk', () => {
  it('no-ops for ok responses', async () => {
    await expect(
      assertExportResponseOk(new Response('ok', { status: 200 }), 'fallback'),
    ).resolves.toBeUndefined()
  })

  it('surfaces JSON detail from failed responses', async () => {
    await expect(
      assertExportResponseOk(
        new Response(JSON.stringify({ detail: '日期格式无效' }), { status: 400 }),
        'fallback',
      ),
    ).rejects.toThrow('日期格式无效')
  })

  it('maps 429 to rate-limit copy', async () => {
    await expect(
      assertExportResponseOk(
        new Response(JSON.stringify({ detail: 'too many' }), { status: 429 }),
        'fallback',
      ),
    ).rejects.toThrow(/过于频繁|最多 5 次/)
  })
})

describe('mapExportDownloadError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps timeout errors to actionable copy', () => {
    const mapped = mapExportDownloadError(
      new Error('Network error: Request absolute timeout (90s)'),
      'fallback',
    )
    expect(mapped.message).toMatch(/超时|timeout/i)
  })

  it('preserves non-timeout Error messages', () => {
    const mapped = mapExportDownloadError(new Error('权限不足'), 'fallback')
    expect(mapped.message).toBe('权限不足')
  })
})
