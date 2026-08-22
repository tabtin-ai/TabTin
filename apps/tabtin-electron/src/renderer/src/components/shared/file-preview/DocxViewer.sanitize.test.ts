/**
 * DocxViewer 图片承载契约回归测试
 *
 * 根因：docx-preview 默认 `useBase64URL: false`，内嵌图片以 `blob:` URL 承载；
 * 而 DocxViewer 渲染后会过 DOMPurify.sanitize，默认 IS_ALLOWED_URI 不放行
 * `blob:`（仅对 `data:` + img 类标签放行），导致 <img src="blob:..."> 的 src
 * 被剥掉、图片全部丢失。修复办法是让 docx-preview 用 `data:` URI 承载图片
 * （useBase64URL: true）。
 *
 * 本测试用 DocxViewer 同款 sanitize 配置，锁住这个契约：blob: 被剥、data: 保留。
 * 若哪天 DOMPurify 放行 blob:（本测试 blob 用例失败），说明可以撤掉 workaround。
 */
import DOMPurify from 'dompurify'
import { describe, expect, it } from 'vitest'

// 与 DocxViewer.tsx 中 renderAsync 后的净化配置保持一致
const SANITIZE_CONFIG = {
  FORBID_TAGS: ['script', 'iframe', 'embed', 'object'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
} as const

function srcSurvives(html: string): boolean {
  const clean = DOMPurify.sanitize(html, SANITIZE_CONFIG)
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  return doc.querySelector('img')?.hasAttribute('src') ?? false
}

describe('DocxViewer 图片 sanitize 契约', () => {
  it('blob: 图片 src 会被 DOMPurify 默认配置剥掉（故不能用 blob: 承载）', () => {
    expect(srcSurvives('<img src="blob:http://x/abc-123" />')).toBe(false)
  })

  it('data: 图片 src 被 DOMPurify 保留（img 在默认 DATA_URI_TAGS 内）', () => {
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    expect(srcSurvives(`<img src="${png}" />`)).toBe(true)
  })
})
