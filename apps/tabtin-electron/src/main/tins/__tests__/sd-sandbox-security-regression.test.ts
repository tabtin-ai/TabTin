/**
 * SD-032/SD-050 回归测试
 *
 * CSP 注入绕过修复 + style-src nonce 替代 unsafe-inline。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const capturedHtml = { value: '' }
const fileStore = new Map<string, string>()

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/mock-user-data' },
  session: { fromPartition: () => ({ clearStorageData: vi.fn() }) },
}))

vi.mock('fs', () => {
  const mocks = {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((_path: string, content: string) => {
      const p = String(_path)
      fileStore.set(p, typeof content === 'string' ? content : '')
      if (p.endsWith('.html')) capturedHtml.value = typeof content === 'string' ? content : ''
    }),
    readFileSync: vi.fn((_path: string) => fileStore.get(String(_path)) ?? ''),
    rmSync: vi.fn(),
    realpathSync: vi.fn((p: unknown) => String(p)),
    chmodSync: vi.fn(),
  }
  return { ...mocks, default: mocks }
})

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

vi.mock('../tin-bridge', () => ({
  generateTinPreloadScript: () => '/* preload */',
}))

import { prepareSandbox } from '../tin-sandbox'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

function makeSandboxConfig(panelHtml = '<div>hello</div>') {
  return {
    instanceId: VALID_UUID,
    panelHtml,
    variables: { foo: 'bar' },
    pageContext: { url: 'https://example.com', title: 'Test' },
  }
}

// ────────────────────────────────────────────────
// SD-032: CSP injection via HTML comment bypass
// ────────────────────────────────────────────────
describe('SD-032: CSP not injectable via HTML comment trick', () => {
  beforeEach(() => {
    capturedHtml.value = ''
    fileStore.clear()
  })

  it('panelHtml with <!-- <head> --> comment still gets CSP before user content', () => {
    const maliciousHtml = '<!-- <head> fake --><html><head><title>Real</title></head><body>content</body></html>'
    prepareSandbox(makeSandboxConfig(maliciousHtml))
    const html = capturedHtml.value

    expect(html).toContain('Content-Security-Policy')
    const cspIndex = html.indexOf('Content-Security-Policy')
    const commentIndex = html.indexOf('<!-- <head>')
    expect(cspIndex).toBeLessThan(commentIndex)
  })

  it('always uses controlled wrapper template regardless of user HTML structure', () => {
    const fullHtml = '<html><head><title>User Tin</title></head><body>content</body></html>'
    prepareSandbox(makeSandboxConfig(fullHtml))
    const html = capturedHtml.value

    expect(html).toMatch(/^<!DOCTYPE html>\s*\n<html lang="zh-CN">/)
    expect(html).toContain('<meta http-equiv="Content-Security-Policy"')
  })

  it('CSP is in our controlled <head>, not user-provided <head>', () => {
    const fullHtml = '<html><head><meta name="custom"></head><body>test</body></html>'
    prepareSandbox(makeSandboxConfig(fullHtml))
    const html = capturedHtml.value

    const ourHeadIndex = html.indexOf('<head>')
    const cspIndex = html.indexOf('Content-Security-Policy')
    const userMetaIndex = html.indexOf('<meta name="custom">')

    expect(ourHeadIndex).toBeLessThan(cspIndex)
    expect(cspIndex).toBeLessThan(userMetaIndex)
  })
})

// ────────────────────────────────────────────────
// SD-050: style-src uses nonce instead of unsafe-inline
// ────────────────────────────────────────────────
describe('SD-050: style-src must use nonce, not unsafe-inline', () => {
  beforeEach(() => {
    capturedHtml.value = ''
    fileStore.clear()
  })

  it('style-src must NOT contain unsafe-inline', () => {
    prepareSandbox(makeSandboxConfig())
    const html = capturedHtml.value
    const styleSrcMatch = html.match(/style-src\s+([^;]+)/)
    expect(styleSrcMatch).toBeTruthy()
    expect(styleSrcMatch![1]).not.toContain("'unsafe-inline'")
  })

  it('style-src contains nonce directive', () => {
    prepareSandbox(makeSandboxConfig())
    const html = capturedHtml.value
    const styleSrcMatch = html.match(/style-src\s+([^;]+)/)
    expect(styleSrcMatch![1]).toMatch(/'nonce-[A-Za-z0-9+/]+=*'/)
  })

  it('style-src-attr allows unsafe-inline for inline style attributes', () => {
    prepareSandbox(makeSandboxConfig())
    const html = capturedHtml.value
    expect(html).toContain("style-src-attr 'unsafe-inline'")
  })

  it('wrapper <style> block has nonce matching CSP nonce', () => {
    prepareSandbox(makeSandboxConfig())
    const html = capturedHtml.value

    const styleNonce = html.match(/<style nonce="([A-Za-z0-9+/]+=*)"/)
    const cspStyleNonce = html.match(/style-src[^;]*'nonce-([A-Za-z0-9+/]+=*)'/)
    const cspScriptNonce = html.match(/script-src[^;]*'nonce-([A-Za-z0-9+/]+=*)'/)

    expect(styleNonce).toBeTruthy()
    expect(cspStyleNonce).toBeTruthy()
    expect(cspScriptNonce).toBeTruthy()

    expect(styleNonce![1]).toBe(cspStyleNonce![1])
    expect(styleNonce![1]).toBe(cspScriptNonce![1])
  })

  it('user panelHtml <style> blocks without nonce would be blocked', () => {
    const htmlWithStyle = '<div><style>.evil { position:fixed; inset:0; z-index:9999; }</style>content</div>'
    prepareSandbox(makeSandboxConfig(htmlWithStyle))
    const html = capturedHtml.value

    const allStyleTags = [...html.matchAll(/<style(?:\s[^>]*)?>[\s\S]*?<\/style>/gi)]
    const withNonce = allStyleTags.filter((m) => m[0].includes('nonce='))
    const withoutNonce = allStyleTags.filter((m) => !m[0].includes('nonce='))

    expect(withNonce.length).toBe(1)
    expect(withoutNonce.length).toBeGreaterThanOrEqual(1)
  })
})
