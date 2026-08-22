import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_ARCHIVE_MESSAGE_KIND,
  buildExternalArchiveBoundaryText,
  buildExternalArchiveSeedRecords,
  contentHasExternalArchiveBoundary,
  transcriptHasExternalArchiveBoundary,
} from '../external-archive-transcript'

const meta = {
  source: 'workbuddy',
  sourceSessionId: 'sess-1',
  title: '互相认识',
  cwd: '/tmp/wb',
}

describe('buildExternalArchiveSeedRecords', () => {
  it('写入外来正文与 LLM 边界，不含 UI 横幅', () => {
    const records = buildExternalArchiveSeedRecords(meta, [
      {
        id: 'm1',
        role: 'user',
        content_blocks: [{ type: 'text', text: '推荐一部电影' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        content_blocks: [{ type: 'text', text: '《盗梦空间》' }],
      },
    ])

    expect(records.map((r) => r.role)).toEqual(['user', 'assistant', 'user'])
    expect(records[0]?.content).toBe('推荐一部电影')
    expect(records[0]?.messageId).toBe('ext-m1')
    expect(records[1]?.content).toBe('《盗梦空间》')
    expect(records[2]?.messageKind).toBe(EXTERNAL_ARCHIVE_MESSAGE_KIND)
    expect(records[2]?.messageId).toBe('ext-llm-boundary-sess-1')
    expect(records[2]?.content).toContain('type="external-archive"')
    expect(records[2]?.content).toContain('WorkBuddy')
    expect(records[2]?.content).toContain('以 TabTin 为准')
  })

  it('空正文消息跳过；全空则不写边界', () => {
    expect(buildExternalArchiveSeedRecords(meta, [
      { id: 'empty', role: 'user', content_blocks: [{ type: 'text', text: '   ' }] },
    ])).toEqual([])
  })
})

describe('external-archive boundary helpers', () => {
  it('识别 string / text block 中的边界', () => {
    const text = buildExternalArchiveBoundaryText(meta)
    expect(contentHasExternalArchiveBoundary(text)).toBe(true)
    expect(contentHasExternalArchiveBoundary([{ type: 'text', text }])).toBe(true)
    expect(transcriptHasExternalArchiveBoundary([
      { content: 'hello' },
      { content: text },
    ])).toBe(true)
  })
})
