import { describe, it, expect, vi, beforeEach } from 'vitest'

const { capturedHtmlRef, mockWriteFileSync, fileStore } = vi.hoisted(() => {
  const capturedHtmlRef = { value: '' }
  const fileStore = new Map<string, string>()
  const mockWriteFileSync = vi.fn((_path: string, content: string) => {
    const p = String(_path)
    fileStore.set(p, typeof content === 'string' ? content : '')
    if (p.endsWith('.html')) capturedHtmlRef.value = content
  })
  return { capturedHtmlRef, mockWriteFileSync, fileStore }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/mock-user-data' },
  session: { fromPartition: () => ({ clearStorageData: vi.fn() }) },
}))

vi.mock('fs', () => {
  const mocks = {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: mockWriteFileSync,
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

import { prepareSandbox, generateCspNonce } from '../tin-sandbox'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

function makeSandboxConfig(panelHtml = '<div>hello</div>') {
  return {
    instanceId: VALID_UUID,
    panelHtml,
    variables: { foo: 'bar' },
    pageContext: { url: 'https://example.com', title: 'Test' },
  }
}

describe('generateCspNonce', () => {
  it('returns a base64 string of consistent length', () => {
    const nonce = generateCspNonce()
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(Buffer.from(nonce, 'base64')).toHaveLength(16)
  })

  it('generates unique values on each call', () => {
    const nonces = new Set(Array.from({ length: 20 }, () => generateCspNonce()))
    expect(nonces.size).toBe(20)
  })
})

describe('TL-014: CSP nonce replaces unsafe-inline for script-src', () => {
  beforeEach(() => {
    capturedHtmlRef.value = ''
    fileStore.clear()
  })

  it('script-src must NOT contain unsafe-inline', () => {
    prepareSandbox(makeSandboxConfig())
    const html = capturedHtmlRef.value
    const scriptSrcMatch = html.match(/script-src\s+[^;]+/)
    expect(scriptSrcMatch).toBeTruthy()
    expect(scriptSrcMatch![0]).not.toContain('unsafe-inline')
  })

  it('script-src contains a nonce directive', () => {
    prepareSandbox(makeSandboxConfig())
    const html = capturedHtmlRef.value
    const scriptSrcMatch = html.match(/script-src\s+([^;]+)/)
    expect(scriptSrcMatch).toBeTruthy()
    expect(scriptSrcMatch![1]).toMatch(/'nonce-[A-Za-z0-9+/]+=*'/)
  })

  it('init <script> tag has matching nonce attribute', () => {
    prepareSandbox(makeSandboxConfig())
    const html = capturedHtmlRef.value
    const nonceInCsp = html.match(/nonce-([A-Za-z0-9+/]+=*)/)
    const nonceInScript = html.match(/<script nonce="([A-Za-z0-9+/]+=*)"/)
    expect(nonceInCsp).toBeTruthy()
    expect(nonceInScript).toBeTruthy()
    expect(nonceInCsp![1]).toBe(nonceInScript![1])
  })

  it('panelHtml inline scripts (without nonce) would be blocked by CSP', () => {
    const malicious = '<div><script>alert("xss")</script></div>'
    prepareSandbox(makeSandboxConfig(malicious))
    const html = capturedHtmlRef.value
    const allScriptTags = [...html.matchAll(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi)]
    const withoutNonce = allScriptTags.filter((m) => !m[0].includes('nonce='))
    const withNonce = allScriptTags.filter((m) => m[0].includes('nonce='))
    expect(withNonce.length).toBe(1)
    expect(withoutNonce.length).toBeGreaterThanOrEqual(1)
    const scriptSrc = html.match(/script-src\s+[^;]+/)![0]
    expect(scriptSrc).not.toContain('unsafe-inline')
  })

  it('each prepareSandbox call uses a different nonce', () => {
    prepareSandbox(makeSandboxConfig())
    const nonce1 = capturedHtmlRef.value.match(/nonce-([A-Za-z0-9+/]+=*)/)![1]
    capturedHtmlRef.value = ''
    prepareSandbox(makeSandboxConfig())
    const nonce2 = capturedHtmlRef.value.match(/nonce-([A-Za-z0-9+/]+=*)/)![1]
    expect(nonce1).not.toBe(nonce2)
  })

  it('works with panelHtml that has existing <html><head> tags', () => {
    const fullHtml = '<html><head><title>Tin</title></head><body>hello</body></html>'
    prepareSandbox(makeSandboxConfig(fullHtml))
    const html = capturedHtmlRef.value
    expect(html).toContain('nonce-')
    expect(html).toContain('Content-Security-Policy')
    const scriptSrcMatch = html.match(/script-src\s+([^;]+)/)
    expect(scriptSrcMatch![1]).not.toContain('unsafe-inline')
  })

  it('style-src uses nonce (not unsafe-inline) for <style> blocks', () => {
    prepareSandbox(makeSandboxConfig())
    const html = capturedHtmlRef.value
    const styleSrcMatch = html.match(/style-src\s+([^;]+)/)
    expect(styleSrcMatch).toBeTruthy()
    expect(styleSrcMatch![1]).not.toContain("'unsafe-inline'")
    expect(styleSrcMatch![1]).toMatch(/'nonce-/)
  })
})

describe('TL-007: empty panelHtml shows fallback instead of blank page', () => {
  beforeEach(() => {
    capturedHtmlRef.value = ''
    fileStore.clear()
  })

  it('renders fallback placeholder when panelHtml is empty string', () => {
    prepareSandbox(makeSandboxConfig(''))
    expect(capturedHtmlRef.value).toContain('Tin 面板尚未就绪')
    expect(capturedHtmlRef.value).not.toMatch(/<body>\s*<\/body>/)
  })

  it('renders fallback placeholder when panelHtml is whitespace-only', () => {
    prepareSandbox(makeSandboxConfig('   \n\t  '))
    expect(capturedHtmlRef.value).toContain('Tin 面板尚未就绪')
  })

  it('renders actual content when panelHtml is non-empty', () => {
    prepareSandbox(makeSandboxConfig('<div>My Tin Panel</div>'))
    expect(capturedHtmlRef.value).toContain('My Tin Panel')
    expect(capturedHtmlRef.value).not.toContain('Tin 面板尚未就绪')
  })

  it('fallback HTML contains informative description', () => {
    prepareSandbox(makeSandboxConfig(''))
    expect(capturedHtmlRef.value).toContain('面板代码尚未配置')
  })

  it('fallback page still includes CSP and init script', () => {
    prepareSandbox(makeSandboxConfig(''))
    expect(capturedHtmlRef.value).toContain('Content-Security-Policy')
    expect(capturedHtmlRef.value).toContain('__TIN_INIT__')
  })
})
