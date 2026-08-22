import { describe, expect, it } from 'vitest'
import {
  buildTablePreviewFromMetadata,
  formatDocumentPreviewLines,
  mergeTablePreview,
  stripInlineMarkdown,
} from './imResourceCardPreview'

describe('formatDocumentPreviewLines', () => {
  it('parses markdown headings / lists / quotes and skips duplicate title', () => {
    const lines = formatDocumentPreviewLines(
      '# 季度规划\n\n## 关系总览\n- 第一点\n- 第二点\n> 重点提示\n普通正文段落。',
      '季度规划',
    )
    expect(lines).toEqual([
      { text: '关系总览', kind: 'h2' },
      { text: '第一点', kind: 'list' },
      { text: '第二点', kind: 'list' },
      { text: '重点提示', kind: 'quote' },
      { text: '普通正文段落。', kind: 'body' },
    ])
  })

  it('strips inline markdown markers and skips code fences / rules', () => {
    const lines = formatDocumentPreviewLines(
      '**加粗**标题\n```\ncode block\n```\n---\n看 [文档](http://x) 和 `代码`',
      undefined,
    )
    expect(lines).toEqual([
      { text: '加粗标题', kind: 'body' },
      { text: '看 文档 和 代码', kind: 'body' },
    ])
  })

  it('degrades plain text (no markdown) to body paragraphs', () => {
    const lines = formatDocumentPreviewLines('第一行\n第二行', undefined)
    expect(lines).toEqual([
      { text: '第一行', kind: 'body' },
      { text: '第二行', kind: 'body' },
    ])
  })
})

describe('stripInlineMarkdown', () => {
  it('removes bold / italic / code / link / image markers', () => {
    expect(stripInlineMarkdown('**b** *i* `c` [t](u) ![a](i)')).toBe('b i c t a')
  })
})

describe('buildTablePreviewFromMetadata', () => {
  it('builds column headers from metadata field names', () => {
    expect(
      buildTablePreviewFromMetadata(
        { field_names: ['客户', '阶段', '负责人'], record_count: 12 },
        undefined,
      ),
    ).toEqual({
      columns: [
        { key: 'col-0', label: '客户' },
        { key: 'col-1', label: '阶段' },
        { key: 'col-2', label: '负责人' },
      ],
      rows: [],
      total_rows: 12,
    })
  })
})

describe('mergeTablePreview', () => {
  it('prefers stored preview rows over metadata fallback', () => {
    expect(
      mergeTablePreview(
        {
          columns: [{ key: 'f1', label: '客户' }],
          rows: [{ f1: 'Acme' }],
          total_rows: 8,
        },
        {
          columns: [{ key: 'col-0', label: '客户' }],
          rows: [],
          total_rows: 8,
        },
      ),
    ).toEqual({
      columns: [{ key: 'f1', label: '客户' }],
      rows: [{ f1: 'Acme' }],
      total_rows: 8,
    })
  })
})
