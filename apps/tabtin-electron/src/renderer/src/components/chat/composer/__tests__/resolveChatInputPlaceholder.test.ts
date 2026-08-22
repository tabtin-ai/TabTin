import { describe, expect, it, vi } from 'vitest'
import { resolveChatInputPlaceholder } from '../resolveChatInputPlaceholder'

function makeT(map: Record<string, string> = {}) {
  return vi.fn((key: string, opts?: { agentName?: string }) => {
    const template = map[key] ?? key
    if (opts?.agentName != null) {
      return template.replace('{{agentName}}', opts.agentName)
    }
    return template
  }) as never
}

const base = {
  agentGatewayStatus: 'ready',
  isStreaming: false,
  disabled: false,
  disabledReason: null,
  isVoiceActive: false,
  pendingApproval: false,
  pendingAskUser: false,
  agentMode: 'agent' as const,
}

describe('resolveChatInputPlaceholder', () => {
  it('默认占位注入当前 Agent 展示名', () => {
    const t = makeT({
      'input.defaultAgentName': '小Tin',
      'input.placeholderDefault': '输入你的任务，{{agentName}} 会帮你完成…',
    })
    expect(resolveChatInputPlaceholder({
      ...base,
      t,
      agentDisplayName: '小明代码版',
    })).toBe('输入你的任务，小明代码版 会帮你完成…')
  })

  it('无展示名时回落 defaultAgentName', () => {
    const t = makeT({
      'input.defaultAgentName': '小Tin',
      'input.placeholderDefault': '输入你的任务，{{agentName}} 会帮你完成…',
    })
    expect(resolveChatInputPlaceholder({
      ...base,
      t,
      agentDisplayName: '  ',
    })).toBe('输入你的任务，小Tin 会帮你完成…')
  })
})
