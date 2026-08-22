import { describe, it, expect } from 'vitest'
import { sanitizeBundleFilename } from '../bundle-filename'

describe('sanitizeBundleFilename', () => {
  it('接受合法 .zip 文件名', () => {
    const name = 'tabtin-diag-preprod-1.2.3-20260703-101010.zip'
    expect(sanitizeBundleFilename(name)).toBe(name)
  })

  it('拒绝路径分隔符与 ..（防目录穿越）', () => {
    expect(sanitizeBundleFilename('../evil.zip')).toBeNull()
    expect(sanitizeBundleFilename('a/b.zip')).toBeNull()
    expect(sanitizeBundleFilename('a\\b.zip')).toBeNull()
  })

  it('拒绝非 .zip 扩展名', () => {
    expect(sanitizeBundleFilename('logs.txt')).toBeNull()
    expect(sanitizeBundleFilename('logs')).toBeNull()
  })

  it('拒绝非法字符与空/非字符串', () => {
    expect(sanitizeBundleFilename('a<b>.zip')).toBeNull()
    expect(sanitizeBundleFilename('')).toBeNull()
    expect(sanitizeBundleFilename(null)).toBeNull()
    expect(sanitizeBundleFilename(123)).toBeNull()
  })
})
