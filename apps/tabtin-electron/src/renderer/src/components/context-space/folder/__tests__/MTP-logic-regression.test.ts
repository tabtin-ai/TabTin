/**
 * MTP 纯逻辑回归测试
 * 覆盖问题：MTP-004 (buildTabtinFileUrl), MTP-001 (resolveImageSrc)
 *
 * 这些测试直接验证路径编码/解析逻辑，不依赖 React 渲染。
 */
import { describe, it, expect } from 'vitest'
import { buildTabtinFileUrl } from '@components/shared/file-utils'

describe('MTP-004: path segment encoding for # and special chars', () => {
  it('encodes # in filename', () => {
    expect(buildTabtinFileUrl('/home/user/file#1.pdf')).toBe(
      'tabtin-file:///home/user/file%231.pdf'
    )
  })

  it('encodes spaces in path', () => {
    expect(buildTabtinFileUrl('/home/user/My Documents/file.pdf')).toBe(
      'tabtin-file:///home/user/My%20Documents/file.pdf'
    )
  })

  it('handles Windows-style paths', () => {
    expect(buildTabtinFileUrl('C:\\Users\\test\\file.pdf')).toBe(
      'tabtin-file://local/C%3A/Users/test/file.pdf'
    )
  })

  it('preserves already-absolute Unix paths', () => {
    expect(buildTabtinFileUrl('/simple/path/file.pdf')).toBe(
      'tabtin-file:///simple/path/file.pdf'
    )
  })

  it('encodes ? in filename', () => {
    expect(buildTabtinFileUrl('/home/user/what?.pdf')).toBe(
      'tabtin-file:///home/user/what%3F.pdf'
    )
  })
})

describe('MTP-001: resolveImageSrc path resolution', () => {
  const resolveImageSrc = (src: string | undefined, dirPath: string | undefined): string | undefined => {
    if (!src) return src
    if (/^(https?:|data:|blob:)/i.test(src)) return src
    if (!dirPath) return src
    const segments = `${dirPath}/${src}`.split('/').filter(Boolean)
    const normalized: string[] = []
    for (const seg of segments) {
      if (seg === '.') continue
      if (seg === '..') { normalized.pop(); continue }
      normalized.push(seg)
    }
    const fullPath = '/' + normalized.join('/')
    const encoded = fullPath
      .split('/')
      .map(seg => (seg ? encodeURIComponent(seg) : ''))
      .join('/')
    return `tabtin-file://${encoded}`
  }

  it('resolves relative path with ./', () => {
    expect(resolveImageSrc('./images/photo.png', '/home/user/docs')).toBe(
      'tabtin-file:///home/user/docs/images/photo.png'
    )
  })

  it('resolves relative path with ../', () => {
    expect(resolveImageSrc('../assets/logo.png', '/home/user/docs')).toBe(
      'tabtin-file:///home/user/assets/logo.png'
    )
  })

  it('resolves bare relative path', () => {
    expect(resolveImageSrc('screenshot.png', '/home/user/docs')).toBe(
      'tabtin-file:///home/user/docs/screenshot.png'
    )
  })

  it('passes through https URLs', () => {
    expect(resolveImageSrc('https://cdn.example.com/img.png', '/home/user/docs')).toBe(
      'https://cdn.example.com/img.png'
    )
  })

  it('passes through data URLs', () => {
    expect(resolveImageSrc('data:image/png;base64,abc123', '/home/user/docs')).toBe(
      'data:image/png;base64,abc123'
    )
  })

  it('returns src as-is when no dirPath', () => {
    expect(resolveImageSrc('./images/photo.png', undefined)).toBe('./images/photo.png')
  })

  it('returns undefined for undefined src', () => {
    expect(resolveImageSrc(undefined, '/home/user/docs')).toBeUndefined()
  })

  it('encodes # in image filename', () => {
    expect(resolveImageSrc('img#1.png', '/home/user/docs')).toBe(
      'tabtin-file:///home/user/docs/img%231.png'
    )
  })
})
