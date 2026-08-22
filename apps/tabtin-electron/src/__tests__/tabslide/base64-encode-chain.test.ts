import { describe, expect, it, vi } from 'vitest'

vi.mock('@tabtin/tabslide/exports', () => ({
  setImportAdapter: vi.fn(),
  convertBackendToPresentation: vi.fn(),
}))

vi.mock('@/services/api', () => ({
  apiService: { request: vi.fn() },
}))

vi.mock('@/components/slide/autosave-utils', () => ({
  unwrapEnvelope: vi.fn(),
}))

vi.mock('@/components/slide/slide-font-utils', () => ({
  sanitizeEmbeddedFonts: vi.fn(() => []),
  sanitizeThemeFonts: vi.fn(() => ({})),
  normalizeFontEmbeddingMeta: vi.fn(() => ({})),
  injectEmbeddedFonts: vi.fn(),
  injectThemeFonts: vi.fn(),
  applyRuntimeFontFamilies: vi.fn(),
  buildThemeFontsFromPresentationTheme: vi.fn(() => ({})),
}))

import { uint8ArrayToBase64 } from '@/components/slide/slide-import-adapter'

describe('HOST-02: uint8ArrayToBase64 chunk-based 编码', () => {
  it('空数组应返回空字符串', () => {
    expect(uint8ArrayToBase64(new Uint8Array([]))).toBe('')
  })

  it('短数据应与 Buffer.toString("base64") 结果一致', () => {
    const data = new TextEncoder().encode('Hello, TabSlide!')
    const expected = Buffer.from(data).toString('base64')
    expect(uint8ArrayToBase64(data)).toBe(expected)
  })

  it('二进制数据（全字节范围 0-255）应正确编码', () => {
    const data = new Uint8Array(256)
    for (let i = 0; i < 256; i++) data[i] = i
    const expected = Buffer.from(data).toString('base64')
    expect(uint8ArrayToBase64(data)).toBe(expected)
  })

  it('超过单个 chunk (32KB) 的数据应正确编码', () => {
    const size = 0x8000 + 1000
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) data[i] = i & 0xff
    const expected = Buffer.from(data).toString('base64')
    expect(uint8ArrayToBase64(data)).toBe(expected)
  })

  it('恰好等于 chunk 边界大小的数据应正确编码', () => {
    const size = 0x8000
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) data[i] = i & 0xff
    const expected = Buffer.from(data).toString('base64')
    expect(uint8ArrayToBase64(data)).toBe(expected)
  })

  it('多个 chunk 的较大数据应正确编码', () => {
    const size = 0x8000 * 3 + 42
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) data[i] = (i * 7 + 13) & 0xff
    const expected = Buffer.from(data).toString('base64')
    expect(uint8ArrayToBase64(data)).toBe(expected)
  })
})
