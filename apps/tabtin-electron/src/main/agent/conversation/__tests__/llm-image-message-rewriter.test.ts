import { describe, expect, it, vi } from 'vitest'

import { rewriteUnreachableImageUrlsInMessages } from '../llm-image-message-rewriter'

describe('rewriteUnreachableImageUrlsInMessages', () => {
  it('本机 OSS 与其他私网图都改写为模型可达的 data URL', async () => {
    const resolveUrl = vi.fn(async (url: string) =>
      `data:image/png;base64,${Buffer.from(url).toString('base64')}`,
    )
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '第一轮' },
          {
            type: 'image' as const,
            // 本机 OSS 对云端模型不可达，Host 必须在进入 Agent Runtime 前内联。
            source: {
              type: 'url' as const,
              url: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=first.png',
            },
            detail: 'auto' as const,
          },
        ],
      },
      {
        role: 'user' as const,
        content: [
          {
            type: 'image' as const,
            // 非 OSS 私网 URL：Django/上游都够不着，仍需客户端改写成 base64
            source: { type: 'url' as const, url: 'http://10.0.0.9/private.png' },
            detail: 'auto' as const,
          },
        ],
      },
      {
        role: 'user' as const,
        content: [
          {
            type: 'image' as const,
            source: { type: 'url' as const, url: 'https://cdn.example/current.png' },
            detail: 'auto' as const,
          },
        ],
      },
    ]

    const rewritten = await rewriteUnreachableImageUrlsInMessages(messages, resolveUrl)

    expect(resolveUrl).toHaveBeenCalledTimes(2)
    expect(resolveUrl).toHaveBeenCalledWith(
      'http://127.0.0.1:6060/api/services/oss/local-object?object_key=first.png',
    )
    expect(resolveUrl).toHaveBeenCalledWith('http://10.0.0.9/private.png')
    expect(JSON.stringify(rewritten)).not.toContain('127.0.0.1')
    expect(JSON.stringify(rewritten)).toContain('data:image/png;base64,')
    expect(JSON.stringify(rewritten)).toContain('https://cdn.example/current.png')
  })

  it('非 OSS 私网图已无法读取时跳过图片，不阻断后续文本轮次', async () => {
    const onFailure = vi.fn()
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '保留正文' },
          {
            type: 'image' as const,
            source: { type: 'url' as const, url: 'http://10.0.0.9/gone.png' },
          },
        ],
      },
    ]

    const rewritten = await rewriteUnreachableImageUrlsInMessages(
      messages,
      async () => { throw new Error('HTTP 404') },
      onFailure,
    )

    expect(rewritten).toEqual([
      { role: 'user', content: [{ type: 'text', text: '保留正文' }] },
    ])
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('10.0.0.9'), expect.any(Error))
  })
})
