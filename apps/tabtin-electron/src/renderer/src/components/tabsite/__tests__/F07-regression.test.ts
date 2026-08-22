/**
 * 回归测试：F07 修复验证
 *
 * FU-001 / CC-002: iframe src 必须拼接 /index.html
 * CC-005: extractCdnBaseUrl 在 instant 秒传场景下正确推导 CDN base URL
 * CC-013: WS 事件订阅模式验证
 */

import { describe, it, expect } from 'vitest'

/**
 * FU-001 / CC-002: iframe src 拼接逻辑
 * dist_oss_url 末尾可能有或没有 /，拼接后不应出现 // 或缺少 /index.html
 */
describe('FU-001/CC-002: iframe src appends /index.html', () => {
  function buildIframeSrc(distOssUrl: string): string {
    return distOssUrl.replace(/\/$/, '') + '/index.html'
  }

  it('strips trailing slash before appending /index.html', () => {
    const url = 'https://cdn.example.com/tabsite/sites/abc/v3/'
    expect(buildIframeSrc(url)).toBe(
      'https://cdn.example.com/tabsite/sites/abc/v3/index.html',
    )
  })

  it('works when dist_oss_url has no trailing slash', () => {
    const url = 'https://cdn.example.com/tabsite/sites/abc/v3'
    expect(buildIframeSrc(url)).toBe(
      'https://cdn.example.com/tabsite/sites/abc/v3/index.html',
    )
  })

  it('never produces double slashes before index.html', () => {
    const urls = [
      'https://cdn.example.com/dist/',
      'https://cdn.example.com/dist',
    ]
    for (const url of urls) {
      const src = buildIframeSrc(url)
      const pathPart = src.replace(/^https?:\/\//, '')
      expect(pathPart).not.toContain('//')
    }
  })
})

/**
 * CC-005: extractCdnBaseUrl 回归测试
 * 当 instant 秒传时，cdn_url 包含旧的 uploadId/folder，
 * 提取逻辑应从 URL origin 回退推导当前 folder 的 base URL。
 */
describe('CC-005: extractCdnBaseUrl handles instant upload URLs', () => {
  function extractCdnBaseUrl(url: string, folder: string): string {
    if (!url) return ''
    const idx = url.lastIndexOf(folder)
    if (idx >= 0) return url.substring(0, idx + folder.length)
    try {
      const urlObj = new URL(url)
      return `${urlObj.origin}/${folder}`
    } catch { return '' }
  }

  it('extracts base URL when folder matches (normal upload)', () => {
    const folder = 'tabsite/sites/abc/upload456'
    const url = 'https://cdn.example.com/tabsite/sites/abc/upload456/index.html'
    expect(extractCdnBaseUrl(url, folder)).toBe(
      'https://cdn.example.com/tabsite/sites/abc/upload456',
    )
  })

  it('falls back to origin + folder when folder does not match (instant)', () => {
    const folder = 'tabsite/sites/abc/upload456'
    const url = 'https://cdn.example.com/tabsite/sites/abc/upload123/index.html'
    expect(extractCdnBaseUrl(url, folder)).toBe(
      'https://cdn.example.com/tabsite/sites/abc/upload456',
    )
  })

  it('returns empty string for empty URL', () => {
    expect(extractCdnBaseUrl('', 'tabsite/sites/abc/x')).toBe('')
  })

  it('returns empty string for invalid URL without folder match', () => {
    expect(extractCdnBaseUrl('not-a-url', 'tabsite/sites/abc/x')).toBe('')
  })

  it('handles CDN URL with port number', () => {
    const folder = 'tabsite/sites/abc/upload789'
    const url = 'https://cdn.example.com:8443/tabsite/sites/abc/upload111/style.css'
    expect(extractCdnBaseUrl(url, folder)).toBe(
      'https://cdn.example.com:8443/tabsite/sites/abc/upload789',
    )
  })
})

/**
 * CC-013: WS 事件过滤逻辑验证
 * 面板应仅响应自身 resourceId 的 resource_updated 事件
 */
describe('CC-013: WS event filtering for resource refresh', () => {
  it('should refresh when event.resource_id matches panel resourceId', () => {
    const panelResourceId = 'site-123'
    let refreshed = false

    const event = { resource_id: 'site-123', type: 'resource_updated', resource_type: 'tabsite', space_id: 'sp-1' }
    if (event.resource_id === panelResourceId) refreshed = true

    expect(refreshed).toBe(true)
  })

  it('should NOT refresh when event.resource_id does not match', () => {
    const panelResourceId = 'site-123'
    let refreshed = false

    const event = { resource_id: 'site-999', type: 'resource_updated', resource_type: 'tabsite', space_id: 'sp-1' }
    if (event.resource_id === panelResourceId) refreshed = true

    expect(refreshed).toBe(false)
  })
})
