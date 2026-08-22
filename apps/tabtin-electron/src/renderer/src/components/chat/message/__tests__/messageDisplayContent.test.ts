import { describe, expect, it } from 'vitest'
import {
  deriveUserMessageDisplayContent,
  extractUserPresetRequestText,
} from '@utils/chat/messageDisplayContent'

describe('messageDisplayContent', () => {
  it('extracts quick-use preset request from referenced context wrapper', () => {
    const raw = [
      '<context type="referenced" stale_after_turn="temp-user-1">',
      '## 用户预设请求: `skill.tabtinWidget.quickUse`',
      '请使用 tabtin-widget，帮我生成一个 123。',
      '视觉风格：清晰简洁',
      '重点展示：1231',
      '</context>',
    ].join('\n')

    expect(extractUserPresetRequestText(raw)).toBe([
      '请使用 tabtin-widget，帮我生成一个 123。',
      '视觉风格：清晰简洁',
      '重点展示：1231',
    ].join('\n'))
  })

  it('never uses summary fields for body (single source = content blocks, no live/history fork)', () => {
    // 没有内容块时不回退摘要字段——摘要是 content_blocks_json 的投影，blocks 为空时
    // 它也必为空；这里即使人为塞了摘要，也一律返回空，杜绝「实时读块 / 历史读摘要」分叉。
    const message = {
      content: '摘要占位',
      text_summary: '摘要占位',
    }
    expect(deriveUserMessageDisplayContent(message)).toBe('')
  })

  it('keeps regular user text derived from its text block', () => {
    expect(
      deriveUserMessageDisplayContent({
        content: '你是？',
        content_blocks_json: [{ type: 'text', text: '你是？' }],
      }),
    ).toBe('你是？')
  })

  it('renders no body for image-only message even if summary is the [富内容] placeholder', () => {
    const message = {
      content: '[富内容]',
      text_summary: '[富内容]',
      content_blocks_json: [
        { type: 'image', url: 'https://example.com/a.png' },
      ],
    }
    expect(deriveUserMessageDisplayContent(message)).toBe('')
  })

  it('derives body from text block, ignoring summary placeholder', () => {
    const message = {
      content: '[富内容]',
      text_summary: '[富内容]',
      content_blocks_json: [
        { type: 'text', text: '看这张图' },
        { type: 'image', url: 'https://example.com/a.png' },
      ],
    }
    expect(deriveUserMessageDisplayContent(message)).toBe('看这张图')
  })

  it('prefers content blocks over summary fields when both present', () => {
    const message = {
      content: '摘要文案',
      content_blocks_json: [{ type: 'text', text: '真实正文' }],
    }
    expect(deriveUserMessageDisplayContent(message)).toBe('真实正文')
  })

  it('#5932 子代理合成指令气泡：必须带 text 块，否则只写 content 时正文为空', () => {
    // SubagentDetailPane 用 run.task 合成 user 消息；#5614 后正文只读 blocks。
    const emptyBlocks = {
      id: 'subagent-task:run-1',
      content: '你是一号子代理。请回复："1号报到，任务完成。" 然后结束。',
      content_blocks_json: [] as { type: string; text?: string }[],
    }
    expect(deriveUserMessageDisplayContent(emptyBlocks)).toBe('')

    const withTextBlock = {
      ...emptyBlocks,
      content_blocks_json: [{ type: 'text', text: emptyBlocks.content }],
    }
    expect(deriveUserMessageDisplayContent(withTextBlock)).toBe(emptyBlocks.content)
  })

  it('extracts preset request from the text block wrapper', () => {
    const message = {
      content: '[富内容]',
      content_blocks_json: [
        {
          type: 'text',
          text: [
            '<context type="referenced" stale_after_turn="temp-user-1">',
            '## 用户预设请求: `skill.tabtinWidget.quickUse`',
            '请使用 tabtin-widget，帮我生成一个 123。',
            '</context>',
          ].join('\n'),
        },
      ],
    }
    expect(deriveUserMessageDisplayContent(message)).toBe(
      '请使用 tabtin-widget，帮我生成一个 123。',
    )
  })
})
