import { describe, expect, it } from 'vitest'
import {
  normalizeLeakedHtmlBlockMarkdown,
  repairLeakedHtmlBlockInPmJson,
} from '../converters/repairLeakedHtmlBlock.js'

const LEAKED_SINGLE_LINE =
  ':::htmlblock{fileId="f1" src="http://127.0.0.1:6060/api/services/oss/local-object?object\\_key=tabdoc%2Fhtml%2Fx.html" title="demo" height="480"} :::'

describe('repairLeakedHtmlBlockInPmJson', () => {
  it('单行段落 + tiptap 转义 URL → htmlBlock', () => {
    const input = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: LEAKED_SINGLE_LINE }],
      }],
    }
    const { pmJson, repaired } = repairLeakedHtmlBlockInPmJson(input)
    expect(repaired).toBe(true)
    expect(pmJson.content?.[0]?.type).toBe('htmlBlock')
    expect(pmJson.content?.[0]?.attrs?.fileId).toBe('f1')
    expect(pmJson.content?.[0]?.attrs?.src).toContain('object_key=tabdoc')
  })

  it('两行段落 open + close → htmlBlock', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'blk-1' },
          content: [{
            type: 'text',
            text: ':::htmlblock{fileId="f1" src="https://x.com/a.html" title="t" height="480"}',
          }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: ':::' }],
        },
      ],
    }
    const { pmJson, repaired } = repairLeakedHtmlBlockInPmJson(input)
    expect(repaired).toBe(true)
    expect(pmJson.content?.[0]?.type).toBe('htmlBlock')
    expect(pmJson.content?.[0]?.attrs?.blockId).toBe('blk-1')
    expect(pmJson.content?.length).toBe(1)
  })

  it('已是 htmlBlock 时不改动', () => {
    const input = {
      type: 'doc',
      content: [{
        type: 'htmlBlock',
        attrs: { fileId: 'f1', src: 'https://x.com/a.html', title: 't', height: 480 },
      }],
    }
    const { pmJson, repaired } = repairLeakedHtmlBlockInPmJson(input)
    expect(repaired).toBe(false)
    expect(pmJson.content?.[0]?.type).toBe('htmlBlock')
  })
})

describe('normalizeLeakedHtmlBlockMarkdown', () => {
  it('单行闭合转为标准两行', () => {
    const normalized = normalizeLeakedHtmlBlockMarkdown(
      ':::htmlblock{fileId="f1" src="https://x.com/a.html" title="t" height="480"} :::',
    )
    expect(normalized).toBe(
      ':::htmlblock{fileId="f1" src="https://x.com/a.html" title="t" height="480"}\n:::',
    )
  })
})
