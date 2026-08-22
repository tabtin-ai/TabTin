import { describe, expect, it } from 'vitest'
import { isCompactionSummaryPresentation } from '@stores/chat/presentation/messageBubble/compactionSummaryPresentation'

const WRAPPED_SUMMARY = [
  '[对话摘要]',
  '',
  '1. 用户请求：设计自动化测试用例',
  '',
  '[摘要结束]',
  '',
  '[最近对话如下]',
].join('\n')

describe('#7339 isCompactionSummaryPresentation', () => {
  it('message_kind=compaction_summary → true（含 role=user 落库形态）', () => {
    expect(isCompactionSummaryPresentation({
      message_kind: 'compaction_summary',
      content: WRAPPED_SUMMARY,
    })).toBe(true)
  })

  it('无 kind 但正文含完整 marker（存量脏数据）→ true', () => {
    expect(isCompactionSummaryPresentation({
      message_kind: 'llm',
      content: WRAPPED_SUMMARY,
    })).toBe(true)
  })

  it('content_blocks_json 含 marker → true', () => {
    expect(isCompactionSummaryPresentation({
      message_kind: 'llm',
      content: '',
      content_blocks_json: [{ type: 'text', text: WRAPPED_SUMMARY }],
    })).toBe(true)
  })

  it('普通用户消息含「摘要」字样但不含完整 marker → false', () => {
    expect(isCompactionSummaryPresentation({
      message_kind: 'llm',
      content: '请给我一段对话摘要模板',
    })).toBe(false)
  })

  it('只有半套 marker → false', () => {
    expect(isCompactionSummaryPresentation({
      content: '[对话摘要]\n只有开头没有结束',
    })).toBe(false)
  })
})
