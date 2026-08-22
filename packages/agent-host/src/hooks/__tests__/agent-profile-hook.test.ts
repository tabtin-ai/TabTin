import { describe, expect, it, vi } from 'vitest'
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
  type Message,
} from '@tabtin/agent-runtime/engine'
import { buildAgentProfileHook } from '../agent-profile-hook.js'

function user(text: string): Message {
  return { role: 'user', content: text }
}

describe('buildAgentProfileHook', () => {
  it('空档案 → 不注入', async () => {
    const hook = buildAgentProfileHook({
      getAgentProfile: () => ({ agentName: '', customRules: '\n' }),
    })
    const messages: Message[] = [user('你好')]
    const state = { messages } as { messages: Message[] }
    await hook.beforeIteration?.({ state } as never)
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toEqual(messages[0])
  })

  it('把 personal + Agent 配置合成同一 user context，贴当前 user 前', async () => {
    const hook = buildAgentProfileHook({
      getAgentProfile: () => ({
        agentName: '小明代码版',
        customRules: '只用 TypeScript',
      }),
      getPersonalRules: () => '个人统一用中文',
    })
    const state = { messages: [user('帮我看报错')] as Message[] }
    await hook.beforeIteration?.({ state } as never)

    expect(state.messages).toHaveLength(2)
    const injected = state.messages[0]!
    expect(injected.role).toBe('system')
    expect(hasInternalMarker(injected, INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION)).toBe(true)
    const text = typeof injected.content === 'string' ? injected.content : ''
    expect(text).toContain('<context type="agent-profile">')
    expect(text).toContain('小明代码版')
    expect(text).not.toContain('当前目标')
    expect(text).toContain('## 人设与规则')
    expect(text).toContain('source="personal_rules"')
    expect(text).toContain('个人统一用中文')
    expect(text).toContain('source="custom_rules"')
    expect(text).toContain('只用 TypeScript')
    expect(text.indexOf('个人统一用中文')).toBeLessThan(
      text.indexOf('只用 TypeScript'),
    )
    expect(state.messages[1]).toEqual(expect.objectContaining({ content: '帮我看报错' }))
  })

  it('仅 personalRules 也注入，存量自由文本无需 Agent 档案', async () => {
    const hook = buildAgentProfileHook({
      getAgentProfile: () => null,
      getPersonalRules: () => '只给结论',
    })
    const state = { messages: [user('开始')] as Message[] }
    await hook.beforeIteration?.({ state } as never)

    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]?.role).toBe('system')
    expect(state.messages[0]?.content).toContain('source="personal_rules"')
    expect(state.messages[0]?.content).toContain('只给结论')
    expect(state.messages[1]?.content).toBe('开始')
  })

  it('per-run 幂等：已有 marker 则跳过', async () => {
    const getAgentProfile = vi.fn(() => ({ agentName: 'A', customRules: 'r' }))
    const hook = buildAgentProfileHook({ getAgentProfile })
    const existing = user('already')
    setInternalMarker(existing, INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION)
    const state = { messages: [existing, user('新消息')] as Message[] }
    await hook.beforeIteration?.({ state } as never)
    expect(getAgentProfile).not.toHaveBeenCalled()
    expect(state.messages).toHaveLength(2)
  })

  it('插在 memory-recall 之后', async () => {
    const memory = user('<context type="memory-recall">memo</context>')
    setInternalMarker(memory, INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION)
    const hook = buildAgentProfileHook({
      getAgentProfile: () => ({ agentName: '小明代码版' }),
    })
    const state = {
      messages: [memory, user('下一句')] as Message[],
    }
    await hook.beforeIteration?.({ state } as never)
    expect(state.messages).toHaveLength(3)
    expect(hasInternalMarker(state.messages[0]!, INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION)).toBe(true)
    expect(hasInternalMarker(state.messages[1]!, INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION)).toBe(true)
    expect(state.messages[2]).toEqual(expect.objectContaining({ content: '下一句' }))
  })

  it('#6316 profile 切换：personal 稳定，下一 run 读取新 Agent 配置', async () => {
    let customRules = 'Agent A：用英文'
    const hook = buildAgentProfileHook({
      getAgentProfile: () => ({ agentName: 'A', customRules }),
      getPersonalRules: () => '个人：简洁',
    })

    const first = { messages: [user('第一轮')] as Message[] }
    await hook.beforeIteration?.({ state: first } as never)
    expect(first.messages[0]?.content).toContain('Agent A：用英文')

    customRules = 'Agent B：用日文'
    const second = { messages: [user('第二轮')] as Message[] }
    await hook.beforeIteration?.({ state: second } as never)
    expect(second.messages[0]?.content).toContain('个人：简洁')
    expect(second.messages[0]?.content).toContain('Agent B：用日文')
    expect(second.messages[0]?.content).not.toContain('Agent A：用英文')
  })

  it('#7289 同 fingerprint 不重新注入（依赖历史最新一份）', async () => {
    const hook = buildAgentProfileHook({
      getAgentProfile: () => ({ agentName: 'A', customRules: '只用 TS' }),
      getPersonalRules: () => '中文',
    })
    const first = { messages: [user('一')] as Message[] }
    await hook.beforeIteration?.({ state: first } as never)
    const text = typeof first.messages[0]?.content === 'string' ? first.messages[0].content : ''
    expect(text).toContain('<context type="agent-profile">')

    const historical = user(text)
    setInternalMarker(historical, INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE)
    const second = { messages: [historical, user('二')] as Message[] }
    await hook.beforeIteration?.({ state: second } as never)

    expect(second.messages).toHaveLength(2)
    expect(
      second.messages.some((m) =>
        hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION),
      ),
    ).toBe(false)
  })

  it('#7289 fingerprint 变化（改规则）则重新注入', async () => {
    let customRules = '旧规则'
    const hook = buildAgentProfileHook({
      getAgentProfile: () => ({ agentName: 'A', customRules }),
      getPersonalRules: () => '中文',
    })
    const first = { messages: [user('一')] as Message[] }
    await hook.beforeIteration?.({ state: first } as never)
    const oldText = typeof first.messages[0]?.content === 'string' ? first.messages[0].content : ''

    const historical = user(oldText)
    setInternalMarker(historical, INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE)
    customRules = '新规则'
    const second = { messages: [historical, user('二')] as Message[] }
    await hook.beforeIteration?.({ state: second } as never)

    expect(second.messages).toHaveLength(3)
    const fresh = second.messages.find((m) =>
      hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION),
    )
    expect(fresh).toBeTruthy()
    expect(fresh?.content).toContain('新规则')
    expect(fresh?.content).not.toContain('旧规则')
  })
})
