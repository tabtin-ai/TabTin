import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderMarkdown } from '../renderMarkdown'
import { sanitizeHtml } from '../sanitizeHtml'

/* ─── EC-12: allowUnsafeHtml 开发模式警告 ─── */

describe('EC-12: allowUnsafeHtml 安全警告', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  const originalEnv = process.env.NODE_ENV

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.NODE_ENV = 'development'
  })

  afterEach(() => {
    warnSpy.mockRestore()
    process.env.NODE_ENV = originalEnv
  })

  it('allowUnsafeHtml=true 在开发模式下应触发 console.warn', async () => {
    await renderMarkdown('# Hello', { allowUnsafeHtml: true })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('allowUnsafeHtml=true')
    )
  })

  it('allowUnsafeHtml=false 不应触发警告', async () => {
    await renderMarkdown('# Hello', { allowUnsafeHtml: false })

    const unsafeWarns = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('allowUnsafeHtml')
    )
    expect(unsafeWarns).toHaveLength(0)
  })

  it('allowUnsafeHtml=true 在生产模式下不应触发警告', async () => {
    process.env.NODE_ENV = 'production'
    await renderMarkdown('# Hello', { allowUnsafeHtml: true })

    const unsafeWarns = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('allowUnsafeHtml')
    )
    expect(unsafeWarns).toHaveLength(0)
  })

  it('allowUnsafeHtml=true 应跳过消毒直接返回原始 HTML', async () => {
    const result = await renderMarkdown('<script>alert(1)</script>', { allowUnsafeHtml: true })
    expect(result.html).toContain('<script>')
  })
})

/* ─── EC-13: SSR regex fallback 警告 ─── */

describe('EC-13: sanitizeHtml SSR regex fallback 警告', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let origDOMParser: typeof globalThis.DOMParser

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    origDOMParser = globalThis.DOMParser
    // @ts-expect-error — 强制进入 regex fallback 路径
    delete globalThis.DOMParser
  })

  afterEach(() => {
    warnSpy.mockRestore()
    globalThis.DOMParser = origDOMParser
  })

  it('DOMParser 不可用时应触发 console.warn', () => {
    sanitizeHtml('<p>test</p>')

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('DOMParser 不可用')
    )
  })

  it('regex fallback 仍应剥离 script 标签', () => {
    const result = sanitizeHtml('<p>safe</p><script>alert(1)</script>')
    expect(result).not.toContain('<script>')
    expect(result).toContain('safe')
  })

  it('DOMParser 可用时不应触发 fallback 警告', () => {
    globalThis.DOMParser = origDOMParser
    sanitizeHtml('<p>test</p>')

    const fallbackWarns = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('DOMParser 不可用')
    )
    expect(fallbackWarns).toHaveLength(0)
  })
})
