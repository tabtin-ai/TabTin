import { describe, expect, it } from 'vitest'
import {
  hasAgentEngineUserInputContent,
  hasValidAgentEngineAttachment,
} from '../agent-engine-query-validation'

describe('agentEngine query user input validation', () => {
  it('允许空文本 + 有效图片附件', () => {
    expect(hasAgentEngineUserInputContent('', [
      { type: 'image', url: 'https://example.com/image.png' },
    ])).toBe(true)
  })

  it('拒绝真正空输入和缺少 runtime 可消费 url 的图片附件', () => {
    expect(hasAgentEngineUserInputContent('   ', [])).toBe(false)
    expect(hasAgentEngineUserInputContent('', [
      { type: 'image', filename: 'missing-url.png' },
    ])).toBe(false)
    expect(hasValidAgentEngineAttachment({
      type: 'image',
      file_id: 'oss-object-only',
    })).toBe(false)
  })
})
