import { describe, it, expect } from 'vitest'
import {
  evaluateMediaDownloadGuardrail,
  isEphemeralSignedUrl,
  DEFAULT_DOWNLOAD_SIZE_THRESHOLD_BYTES,
} from '../resources/media-download-guardrail'

describe('isEphemeralSignedUrl', () => {
  it('GitHub private-user-images（短期 JWT，BR-30 主案例）→ true', () => {
    expect(
      isEphemeralSignedUrl(
        'https://private-user-images.githubusercontent.com/123/abc.mp4?jwt=eyJhbGciOiJ',
      ),
    ).toBe(true)
    // host 命中即判，即便 jwt 参数缺失（仍是短期资产）。
    expect(
      isEphemeralSignedUrl('https://private-user-images.githubusercontent.com/123/abc.mp4'),
    ).toBe(true)
  })

  it('AWS S3 预签名（X-Amz-Signature）→ true', () => {
    expect(
      isEphemeralSignedUrl(
        'https://bucket.s3.amazonaws.com/key.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA&X-Amz-Date=20260101T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abcdef',
      ),
    ).toBe(true)
  })

  it('Google Cloud Storage 预签名（X-Goog-Signature）→ true', () => {
    expect(
      isEphemeralSignedUrl(
        'https://storage.googleapis.com/bucket/key.mp4?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Expires=900&X-Goog-Signature=deadbeef',
      ),
    ).toBe(true)
  })

  it('CloudFront 签名 URL（Key-Pair-Id）→ true', () => {
    expect(
      isEphemeralSignedUrl(
        'https://d111.cloudfront.net/video.mp4?Expires=1700000000&Signature=xyz&Key-Pair-Id=APKA123',
      ),
    ).toBe(true)
  })

  it('通用 JWT 参数 → true', () => {
    expect(isEphemeralSignedUrl('https://cdn.example.com/v.mp4?jwt=eyJ.payload.sig')).toBe(true)
  })

  it('通用「签名 + 过期」组合（token + expires）→ true', () => {
    expect(
      isEphemeralSignedUrl('https://cdn.example.com/v.mp4?token=abc123&expires=1700000000'),
    ).toBe(true)
  })

  it('Azure SAS（sig + se 过期）→ true', () => {
    expect(
      isEphemeralSignedUrl(
        'https://acct.blob.core.windows.net/c/v.mp4?sv=2021&se=2026-01-01T00:00:00Z&sig=base64sig',
      ),
    ).toBe(true)
  })

  it('普通静态资源 URL（无 query）→ false', () => {
    expect(isEphemeralSignedUrl('https://example.com/video.mp4')).toBe(false)
    expect(isEphemeralSignedUrl('https://example.com/path/to/image.png')).toBe(false)
  })

  it('普通带 query 但非签名（?id=123 / 单独 ?token=）→ false（不误伤）', () => {
    expect(isEphemeralSignedUrl('https://example.com/img.png?id=123&w=800')).toBe(false)
    // 单独 token、无过期标志 → 不命中（可能是长期 API key 等）。
    expect(isEphemeralSignedUrl('https://example.com/v.mp4?token=longlivedkey')).toBe(false)
    // 单独 expires、无签名标志 → 不命中（如 cache 控制参数）。
    expect(isEphemeralSignedUrl('https://example.com/v.mp4?expires=1700000000')).toBe(false)
  })

  it('非法 / 缺省 URL → false', () => {
    expect(isEphemeralSignedUrl(undefined)).toBe(false)
    expect(isEphemeralSignedUrl('')).toBe(false)
    expect(isEphemeralSignedUrl('not a url')).toBe(false)
    expect(isEphemeralSignedUrl('/relative/path.mp4')).toBe(false)
  })
})

describe('evaluateMediaDownloadGuardrail — 单信号', () => {
  it('临时签名 URL → requiresConfirm，signals 含 ephemeral-signed-url', () => {
    const r = evaluateMediaDownloadGuardrail({
      url: 'https://private-user-images.githubusercontent.com/1/a.mp4?jwt=x',
    })
    expect(r.requiresConfirm).toBe(true)
    expect(r.signals).toContain('ephemeral-signed-url')
    expect(r.suggestAsync).toBe(false)
    expect(r.reasons.length).toBe(r.signals.length)
  })

  it('跨站资源（url 与 pageUrl 不同源）→ cross-origin', () => {
    const r = evaluateMediaDownloadGuardrail({
      url: 'https://cdn.other.com/v.mp4',
      pageUrl: 'https://app.example.com/watch',
    })
    expect(r.requiresConfirm).toBe(true)
    expect(r.signals).toEqual(['cross-origin'])
  })

  it('同源资源 → 不命中 cross-origin', () => {
    const r = evaluateMediaDownloadGuardrail({
      url: 'https://app.example.com/assets/v.mp4',
      pageUrl: 'https://app.example.com/watch',
    })
    expect(r.requiresConfirm).toBe(false)
    expect(r.signals).toEqual([])
  })

  it('缺 pageUrl → 跳过 cross-origin 判定（纯函数不猜页面上下文）', () => {
    const r = evaluateMediaDownloadGuardrail({ url: 'https://cdn.other.com/v.mp4' })
    expect(r.requiresConfirm).toBe(false)
    expect(r.signals).toEqual([])
  })

  it('大文件（size > 阈值）→ large-file + suggestAsync', () => {
    const r = evaluateMediaDownloadGuardrail({
      url: 'https://example.com/big.mp4',
      size: DEFAULT_DOWNLOAD_SIZE_THRESHOLD_BYTES + 1,
    })
    expect(r.requiresConfirm).toBe(true)
    expect(r.signals).toEqual(['large-file'])
    expect(r.suggestAsync).toBe(true)
  })

  it('恰好等于阈值 → 不命中（严格大于）', () => {
    const r = evaluateMediaDownloadGuardrail({
      url: 'https://example.com/v.mp4',
      size: DEFAULT_DOWNLOAD_SIZE_THRESHOLD_BYTES,
    })
    expect(r.requiresConfirm).toBe(false)
  })

  it('自定义阈值生效', () => {
    const r = evaluateMediaDownloadGuardrail(
      { url: 'https://example.com/v.mp4', size: 11 * 1024 * 1024 },
      { sizeThresholdBytes: 10 * 1024 * 1024 },
    )
    expect(r.signals).toEqual(['large-file'])
  })

  it('size 非法（NaN / 负 / 非数字）→ 跳过 large-file', () => {
    expect(evaluateMediaDownloadGuardrail({ url: 'https://x.com/a', size: NaN }).requiresConfirm).toBe(false)
    expect(evaluateMediaDownloadGuardrail({ url: 'https://x.com/a', size: -1 }).requiresConfirm).toBe(false)
  })

  it('需会话（requiresSession）→ requires-session', () => {
    const r = evaluateMediaDownloadGuardrail({
      url: 'https://example.com/v.mp4',
      requiresSession: true,
    })
    expect(r.requiresConfirm).toBe(true)
    expect(r.signals).toEqual(['requires-session'])
  })
})

describe('evaluateMediaDownloadGuardrail — 组合 / 边界', () => {
  it('多信号叠加：临时签名 + 跨站 + 大文件（BR-30 GitHub 视频典型）', () => {
    const r = evaluateMediaDownloadGuardrail({
      url: 'https://private-user-images.githubusercontent.com/1/a.mp4?jwt=x',
      pageUrl: 'https://github.com/owner/repo',
      size: 200 * 1024 * 1024,
    })
    expect(r.requiresConfirm).toBe(true)
    expect(r.suggestAsync).toBe(true)
    expect(r.signals).toEqual(['ephemeral-signed-url', 'cross-origin', 'large-file'])
    expect(r.reasons.length).toBe(3)
  })

  it('无任何风险信号（同站小文件静态资源）→ 不需确认（保正常采集顺滑）', () => {
    const r = evaluateMediaDownloadGuardrail({
      url: 'https://example.com/photo.jpg',
      pageUrl: 'https://example.com/gallery',
      size: 1024 * 1024,
    })
    expect(r.requiresConfirm).toBe(false)
    expect(r.suggestAsync).toBe(false)
    expect(r.signals).toEqual([])
    expect(r.reasons).toEqual([])
  })

  it('空请求（无 url / size）→ 不命中', () => {
    const r = evaluateMediaDownloadGuardrail({})
    expect(r.requiresConfirm).toBe(false)
    expect(r.signals).toEqual([])
  })

  it('signals 顺序稳定（ephemeral → cross-origin → large-file → requires-session）', () => {
    const r = evaluateMediaDownloadGuardrail({
      url: 'https://cdn.other.com/v.mp4?token=a&expires=1',
      pageUrl: 'https://app.example.com/x',
      size: 999 * 1024 * 1024,
      requiresSession: true,
    })
    expect(r.signals).toEqual([
      'ephemeral-signed-url',
      'cross-origin',
      'large-file',
      'requires-session',
    ])
  })
})
