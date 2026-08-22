import { describe, expect, it } from 'vitest'
import { normalizeSchemelessWebHref } from '../normalize-web-href'

describe('normalizeSchemelessWebHref', () => {
  it('给 www. 主机补 https', () => {
    expect(normalizeSchemelessWebHref('www.baidu.com')).toBe('https://www.baidu.com')
    expect(normalizeSchemelessWebHref('WWW.Baidu.com/s?wd=hi')).toBe(
      'https://WWW.Baidu.com/s?wd=hi',
    )
  })

  it('协议相对地址补 https', () => {
    expect(normalizeSchemelessWebHref('//www.example.com/path')).toBe(
      'https://www.example.com/path',
    )
  })

  it('已有协议、内部资源和相对路径不动', () => {
    expect(normalizeSchemelessWebHref('https://www.baidu.com')).toBe('https://www.baidu.com')
    expect(normalizeSchemelessWebHref('mailto:hi@example.com')).toBe('mailto:hi@example.com')
    expect(normalizeSchemelessWebHref('tabtin://resource/file/a')).toBe(
      'tabtin://resource/file/a',
    )
    expect(normalizeSchemelessWebHref('./notes.md')).toBe('./notes.md')
    expect(normalizeSchemelessWebHref('readme.md')).toBe('readme.md')
    expect(normalizeSchemelessWebHref('baidu.com')).toBe('baidu.com')
  })

  it('空白原样返回', () => {
    expect(normalizeSchemelessWebHref('')).toBe('')
    expect(normalizeSchemelessWebHref('   ')).toBe('   ')
  })
})
