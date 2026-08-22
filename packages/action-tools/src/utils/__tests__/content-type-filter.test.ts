import { describe, it, expect } from 'vitest'
import {
  parseContentTypeWhitelist,
  filterHtmlByContentTypes,
  turndownRemovalFromWhitelist,
  type ContentType,
} from '../content-type-filter'

const wl = (raw: unknown) => parseContentTypeWhitelist(raw) ?? new Set<ContentType>()

describe('parseContentTypeWhitelist', () => {
  it('未传 → null（= 调用方未指定，保持不过滤）', () => {
    expect(parseContentTypeWhitelist(undefined)).toBeNull()
    expect(parseContentTypeWhitelist(null)).toBeNull()
  })

  it('空串 / 空数组 → 空集合（= 全部剥离）', () => {
    expect(parseContentTypeWhitelist('')?.size).toBe(0)
    expect(parseContentTypeWhitelist([])?.size).toBe(0)
  })

  it('逗号分隔字符串解析', () => {
    const set = parseContentTypeWhitelist('images,links')!
    expect([...set].sort()).toEqual(['images', 'links'])
  })

  it('单复数 / 别名归一', () => {
    const set = parseContentTypeWhitelist('image, anchor, video, table, form')!
    expect([...set].sort()).toEqual(['forms', 'images', 'links', 'media', 'tables'])
  })

  it('all / * → 全部保留', () => {
    expect(parseContentTypeWhitelist('all')?.size).toBe(5)
    expect(parseContentTypeWhitelist('*')?.size).toBe(5)
  })

  it('未知 token 静默忽略', () => {
    const set = parseContentTypeWhitelist('images, bogus, weird')!
    expect([...set]).toEqual(['images'])
  })
})

describe('filterHtmlByContentTypes', () => {
  const HTML = `
    <div>
      <p>正文段落</p>
      <a href="https://x.com">链接文本</a>
      <img src="a.png" alt="图">
      <video src="v.mp4"></video>
      <table><tr><td>单元格</td></tr></table>
      <input type="text">
    </div>`

  it('空白名单 → 剥离全部可过滤类型，只留正文与链接文本', () => {
    const out = filterHtmlByContentTypes(HTML, wl(''))
    expect(out).toContain('正文段落')
    expect(out).toContain('链接文本') // 链接 unwrap 保留文本
    expect(out).not.toContain('href') // <a> 已剥
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<video')
    expect(out).not.toContain('<table')
    expect(out).not.toContain('<input')
    expect(out).not.toContain('单元格') // 表格整体剥离
  })

  it('--include links → 保留链接（含 href），其余剥离', () => {
    const out = filterHtmlByContentTypes(HTML, wl('links'))
    expect(out).toContain('href="https://x.com"')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<table')
  })

  it('--include images,tables → 保留图片与表格', () => {
    const out = filterHtmlByContentTypes(HTML, wl('images,tables'))
    expect(out).toContain('<img')
    expect(out).toContain('单元格')
    expect(out).not.toContain('href') // 链接仍剥
    expect(out).not.toContain('<video')
  })

  it('all → 全部保留，等于原样（关键元素都在）', () => {
    const out = filterHtmlByContentTypes(HTML, wl('all'))
    expect(out).toContain('<img')
    expect(out).toContain('href')
    expect(out).toContain('<video')
    expect(out).toContain('<table')
    expect(out).toContain('<input')
  })

  it('空 html 原样返回', () => {
    expect(filterHtmlByContentTypes('', wl(''))).toBe('')
  })
})

describe('turndownRemovalFromWhitelist', () => {
  it('空白名单 → 全部 remove', () => {
    expect(turndownRemovalFromWhitelist(wl(''))).toEqual({
      removeImages: true,
      removeLinks: true,
      removeMedia: true,
      removeTables: true,
    })
  })

  it('images,links → 只保留这两类', () => {
    expect(turndownRemovalFromWhitelist(wl('images,links'))).toEqual({
      removeImages: false,
      removeLinks: false,
      removeMedia: true,
      removeTables: true,
    })
  })
})
