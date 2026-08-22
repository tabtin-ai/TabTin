import { describe, expect, it } from 'vitest'
import { deriveToolUseLifecycleState } from '../deriveToolUseLifecycleState'

describe('deriveToolUseLifecycleState · intent 可见阶段', () => {
  it('工具参数已封口但尚未真正开始时仍保持 calling，不误标 executing', () => {
    const state = deriveToolUseLifecycleState({
      lifecycleEvent: {
        phase: 'start',
        intent: '写入项目配置',
      },
      entryFinalized: true,
      isStreaming: true,
      isLastAssistantMsg: true,
    })

    expect(state.phase).toBe('start')
    expect(state.intent).toBe('写入项目配置')
  })
})
