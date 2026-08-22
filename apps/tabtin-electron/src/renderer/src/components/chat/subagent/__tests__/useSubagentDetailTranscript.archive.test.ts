import { describe, expect, it } from 'vitest'
import { replayArchivedSubagentMessages } from '../useSubagentDetailTranscript'

describe('replayArchivedSubagentMessages', () => {
  it('把 message-block transcript 适配为可渲染消息', () => {
    const messages = replayArchivedSubagentMessages([
      {
        role: 'assistant',
        messageId: 'assistant-1',
        blocks: [{ type: 'text', text: '完成结果' }],
        timestamp: '2026-08-15T00:00:00.000Z',
      },
    ], 'transcript', 'child-run-1')

    expect(messages).toMatchObject([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '完成结果',
        content_blocks_json: [{ type: 'text', text: '完成结果' }],
      },
    ])
  })
})
