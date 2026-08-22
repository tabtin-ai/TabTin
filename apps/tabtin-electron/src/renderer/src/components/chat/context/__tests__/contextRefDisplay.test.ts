/**
 * contextRefDisplay 单元测试（ 回归钉死）
 *
 * 根因：引用 README.md 等文件时，ContextRefCard 误把 `preview`（文件原文，
 * 可能以 `<div align="center">` 开头）的首行当作卡片来源标题，于是出现
 * 「代码文件 <div>」并露出 HTML 片段。修复后 code_file / code_selection
 * 必须用 file_path 的文件名作来源标题。
 */

import { describe, expect, it } from 'vitest'

import { getRefSourceLabel, refBasename } from '../contextRefDisplay'

describe('refBasename', () => {
  it('取 posix 路径最后一段', () => {
    expect(refBasename('/Users/me/proj/README.md')).toBe('README.md')
  })

  it('兼容 windows 反斜杠分隔', () => {
    expect(refBasename('C:\\repo\\src\\index.ts')).toBe('index.ts')
  })

  it('无分隔时原样返回', () => {
    expect(refBasename('README.md')).toBe('README.md')
  })
})

describe('getRefSourceLabel', () => {
  it('code_file：用文件名作来源标题，绝不用 preview 原文', () => {
    const label = getRefSourceLabel({
      type: 'code_file',
      file_path: '/Users/me/proj/README.md',
      preview: '<div align="center">\n[**简体中文**](README_zh_CN.md)\n</div>',
    })
    expect(label).toBe('README.md')
    expect(label).not.toContain('<div')
  })

  it('code_file：缺 file_path 时才退回 preview 首行', () => {
    expect(getRefSourceLabel({ type: 'code_file', preview: 'first\nsecond' })).toBe('first')
  })

  it('code_selection：文件名带上行号区间', () => {
    expect(
      getRefSourceLabel({
        type: 'code_selection',
        file_path: '/a/b/util.ts',
        start_line: 10,
        end_line: 25,
        preview: 'export function x() {}',
      }),
    ).toBe('util.ts:10-25')
  })

  it('code_selection：无行号时只用文件名', () => {
    expect(
      getRefSourceLabel({ type: 'code_selection', file_path: '/a/b/util.ts', preview: 'x' }),
    ).toBe('util.ts')
  })

  it('非 code 类型（document / table / web 等）一律退回 preview 首行（保持历史行为）', () => {
    expect(getRefSourceLabel({ type: 'document', preview: '需求文档\n第二行' })).toBe('需求文档')
    expect(getRefSourceLabel({ type: 'table', preview: '订单表' })).toBe('订单表')
    expect(getRefSourceLabel({ type: 'web_selection', preview: '段落原文\n第二行' })).toBe('段落原文')
  })

  it('preview 为空时返回空串，不抛错', () => {
    expect(getRefSourceLabel({ type: 'document' })).toBe('')
  })
})
