/**
 * schedule-preview API 契约：listSchedulePreview 拼参、解析 envelope、尊重 AbortSignal。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiRequest, getAuthToken } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  getAuthToken: vi.fn(async () => 'test-token'),
}))

vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest,
  getAuthToken,
}))

vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}))

vi.mock('@/config/api', () => ({
  API_CONFIG: { baseURL: 'http://localhost:6060/api' },
}))

import { listSchedulePreview } from '../trackerApi'

describe('listSchedulePreview', () => {
  beforeEach(() => {
    apiRequest.mockReset()
    getAuthToken.mockClear()
  })

  it('按 organization / space / from / to 请求 schedule-preview 并返回 occurrences', async () => {
    apiRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          occurrences: [
            {
              tracker_id: 't1',
              name: '晨报',
              space_id: null,
              space_name: '产品',
              scheduled_at: '2026-07-22T01:00:00.000Z',
              status: 'active',
              trigger_type: 'cron',
              timezone: 'Asia/Shanghai',
            },
          ],
          truncated: true,
        },
      },
    })

    const result = await listSchedulePreview('org-1', {
      spaceId: 'space-1',
      from: '2026-07-20T00:00:00.000Z',
      to: '2026-07-27T00:00:00.000Z',
    })

    expect(result.truncated).toBe(true)
    expect(result.occurrences).toHaveLength(1)
    expect(result.occurrences[0].name).toBe('晨报')
    expect(result.occurrences[0].space_id).toBeNull()

    const call = apiRequest.mock.calls[0][0] as { url: string; method: string }
    expect(call.method).toBe('GET')
    expect(call.url).toContain('/tracker/schedule-preview?')
    const url = new URL(call.url)
    expect(url.searchParams.get('organization_id')).toBe('org-1')
    expect(url.searchParams.get('space_id')).toBe('space-1')
    expect(url.searchParams.get('from')).toBe('2026-07-20T00:00:00.000Z')
    expect(url.searchParams.get('to')).toBe('2026-07-27T00:00:00.000Z')
    expect(url.searchParams.get('from')).toMatch(/T.*(Z|[+-]\d{2}:\d{2})$/)
    expect(url.searchParams.get('to')).toMatch(/T.*(Z|[+-]\d{2}:\d{2})$/)
  })

  it('organization scope 不传 space_id', async () => {
    apiRequest.mockResolvedValue({
      status: 200,
      data: { success: true, data: { occurrences: [], truncated: false } },
    })

    await listSchedulePreview('org-1', {
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    })

    const call = apiRequest.mock.calls[0][0] as { url: string }
    expect(call.url).toContain('organization_id=org-1')
    expect(call.url).not.toContain('space_id=')
  })

  it('signal 已 abort 时不发起请求', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      listSchedulePreview('org-1', {
        from: '2026-07-20T00:00:00.000Z',
        to: '2026-07-27T00:00:00.000Z',
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort|AbortError/i)

    expect(apiRequest).not.toHaveBeenCalled()
  })
})
