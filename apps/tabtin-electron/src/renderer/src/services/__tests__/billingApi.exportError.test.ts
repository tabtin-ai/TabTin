import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  },
}))

import { resolveBillingExportErrorMessage } from '../billingApi'

function jsonResponse(body: unknown, status = 400): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('resolveBillingExportErrorMessage ', () => {
  it('reads TabTin http_error_handler envelope message', async () => {
    const msg = await resolveBillingExportErrorMessage(
      jsonResponse({
        success: false,
        message: '日期范围最大 90 天',
        data: null,
        code: 'HTTP_400',
      }),
    )
    expect(msg).toBe('日期范围最大 90 天')
  })

  it('prefers non-empty message over detail', async () => {
    const msg = await resolveBillingExportErrorMessage(
      jsonResponse({ message: '自定义消息', detail: 'detail 侧文案' }),
    )
    expect(msg).toBe('自定义消息')
  })

  it('reads detail when message is absent (Ninja default shape)', async () => {
    const msg = await resolveBillingExportErrorMessage(
      jsonResponse({ detail: '导出日期范围不能超过 90 天' }),
    )
    expect(msg).toBe('导出日期范围不能超过 90 天')
  })

  it('reads detail for rate-limit and invalid schema style errors', async () => {
    await expect(
      resolveBillingExportErrorMessage(
        jsonResponse({ detail: '导出频率超限，每小时最多 5 次' }, 429),
      ),
    ).resolves.toBe('导出频率超限，每小时最多 5 次')

    await expect(
      resolveBillingExportErrorMessage(
        jsonResponse({ detail: "Invalid schema 'foo'" }, 400),
      ),
    ).resolves.toBe("Invalid schema 'foo'")
  })

  it('ignores blank message/detail and falls back', async () => {
    const msg = await resolveBillingExportErrorMessage(
      jsonResponse({ message: '   ', detail: '' }),
    )
    expect(msg).toBe('导出失败，请重试')
  })

  it('falls back on non-JSON bodies', async () => {
    const msg = await resolveBillingExportErrorMessage(
      new Response('plain error', { status: 500 }),
    )
    expect(msg).toBe('导出失败，请重试')
  })
})
