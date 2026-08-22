import { describe, expect, it } from 'vitest'
import {
  inferElementLinkType,
  normalizeRichTextHyperlinkInput,
  normalizeSlideLinkTarget,
  normalizeWebHyperlinkInput,
  parseRichTextHyperlinkHref,
} from '../../../../../packages/tabslide/src/utils/hyperlink'

describe('TabSlide Hyperlink Utils Chain', () => {
  it('normalizeWebHyperlinkInput 仅保留安全协议并补全 https', () => {
    expect(normalizeWebHyperlinkInput('example.com')).toBe('https://example.com')
    expect(normalizeWebHyperlinkInput('//example.com')).toBe('https://example.com')
    expect(normalizeWebHyperlinkInput('mailto:hello@example.com')).toBe('mailto:hello@example.com')
    expect(normalizeWebHyperlinkInput('tel:+8613811112222')).toBe('tel:+8613811112222')
    expect(normalizeWebHyperlinkInput('javascript:alert(1)')).toBeUndefined()
  })

  it('normalizeSlideLinkTarget 归一化 slide 目标为 page-N', () => {
    expect(normalizeSlideLinkTarget('page-2')).toBe('page-2')
    expect(normalizeSlideLinkTarget('slide3.xml')).toBe('page-3')
    expect(normalizeSlideLinkTarget('4')).toBe('page-4')
    expect(normalizeSlideLinkTarget('page-0')).toBeUndefined()
    expect(normalizeSlideLinkTarget('abc')).toBeUndefined()
  })

  it('inferElementLinkType 可根据目标推断 slide/web', () => {
    expect(inferElementLinkType('page-8', 'web')).toBe('slide')
    expect(inferElementLinkType('slide2.xml', 'web')).toBe('slide')
    expect(inferElementLinkType('https://www.example.com', 'web')).toBe('web')
  })

  it('richText 链接输入支持内部页跳转与外链双语义', () => {
    expect(normalizeRichTextHyperlinkInput('page-2')).toEqual({
      type: 'slide',
      target: 'page-2',
      href: '#page-2',
    })
    expect(normalizeRichTextHyperlinkInput('#page-3')).toEqual({
      type: 'slide',
      target: 'page-3',
      href: '#page-3',
    })
    expect(normalizeRichTextHyperlinkInput('https://www.example.com')).toEqual({
      type: 'web',
      target: 'https://www.example.com',
      href: 'https://www.example.com',
    })
  })

  it('richText href 解析可区分 slide/web', () => {
    expect(parseRichTextHyperlinkHref('#page-7')).toEqual({
      type: 'slide',
      target: 'page-7',
    })
    expect(parseRichTextHyperlinkHref('slide9.xml')).toEqual({
      type: 'slide',
      target: 'page-9',
    })
    expect(parseRichTextHyperlinkHref('mailto:hello@example.com')).toEqual({
      type: 'web',
      target: 'mailto:hello@example.com',
    })
  })
})
