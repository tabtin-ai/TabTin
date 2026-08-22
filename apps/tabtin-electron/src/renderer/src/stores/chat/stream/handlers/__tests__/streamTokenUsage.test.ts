/**
 * streamTokenUsage 单测（ token 用量实时更新）。
 *
 * 覆盖：
 *   §1 message_delta usage → 活态 assistant 消息 usage_json 实时写入
 *   §2 session 累计增量：cumulative 语义、重复事件免疫、多 LLM 调用累加
 *   §3 DONE 差额校正：只补 done − 流式已加、trace_id 幂等、无流式时全额
 *   §4 placeholder（输入侧全 0）跳过 usage_json 写入
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyStreamingMessageDeltaUsage,
  applyDoneUsage,
  clearStreamTokenUsageForSession,
  __resetStreamTokenUsageForTests,
} from '../streamTokenUsage'

interface MockSession {
  id: string
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface MockMessage {
  id: string
  role: string
  content: string
  usage_json?: Record<string, unknown> | null
}

const mockState: {
  sessions: MockSession[]
  messagesBySessionId: Record<string, MockMessage[]>
} = { sessions: [], messagesBySessionId: {} }

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      sessions: mockState.sessions,
      messagesBySessionId: mockState.messagesBySessionId,
      patchMessageById: (
        sessionId: string,
        messageId: string,
        patcher: (m: MockMessage) => MockMessage,
      ) => {
        mockState.messagesBySessionId[sessionId] = (mockState.messagesBySessionId[sessionId] ?? [])
          .map(m => m.id === messageId ? patcher(m) : m)
      },
      // 与真实实现同语义：Math.max 单调写入
      updateSessionTokenUsageInCaches: (
        sessionId: string,
        usage: {
          input_tokens?: number
          output_tokens?: number
          total_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        },
      ) => {
        const session = mockState.sessions.find(s => s.id === sessionId)
        if (!session) return
        for (const key of [
          'input_tokens',
          'output_tokens',
          'total_tokens',
          'cache_read_input_tokens',
          'cache_creation_input_tokens',
        ] as const) {
          const incoming = usage[key]
          if (incoming == null) continue
          session[key] = Math.max(session[key] ?? 0, incoming)
        }
      },
    }),
  },
}))

const SESSION = 'session-1'
const MSG_A = 'msg-a'
const MSG_B = 'msg-b'

beforeEach(() => {
  __resetStreamTokenUsageForTests()
  mockState.sessions = [{ id: SESSION, input_tokens: 0, output_tokens: 0, total_tokens: 0 }]
  mockState.messagesBySessionId = {
    [SESSION]: [
      { id: MSG_A, role: 'assistant', content: '' },
      { id: MSG_B, role: 'assistant', content: '' },
      { id: 'msg-user', role: 'user', content: 'hi' },
    ],
  }
})

function session(): MockSession {
  return mockState.sessions[0]!
}

function message(id: string): MockMessage | undefined {
  return mockState.messagesBySessionId[SESSION]!.find(m => m.id === id)
}

describe('§1 usage_json 实时写入（上下文环 anchor）', () => {
  it('message_delta usage 写到对应 assistant 消息的 usage_json', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, {
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
    })
    expect(message(MSG_A)?.usage_json).toEqual({
      input_tokens: 1000,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
      output_tokens: 50,
    })
    expect(message(MSG_B)?.usage_json).toBeUndefined()
  })

  it('cumulative 更新覆盖旧 usage_json（同一 LLM 调用后到的更全）', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, output_tokens: 10 })
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, output_tokens: 80 })
    expect(message(MSG_A)?.usage_json).toMatchObject({ input_tokens: 1000, output_tokens: 80 })
  })

  it('非 assistant 消息 / 不存在的消息不写 usage_json，但 session 累计仍生效', () => {
    applyStreamingMessageDeltaUsage(SESSION, 'msg-user', { input_tokens: 100, output_tokens: 5 })
    expect(message('msg-user')?.usage_json).toBeUndefined()
    expect(session().input_tokens).toBe(100)
  })
})

describe('§2 session 累计增量', () => {
  it('单次 LLM 调用：input/output/total 实时累加', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, output_tokens: 50 })
    expect(session()).toMatchObject({ input_tokens: 1000, output_tokens: 50, total_tokens: 1050 })
  })

  it('同一消息 cumulative 递增只加增量', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, output_tokens: 10 })
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, output_tokens: 80 })
    expect(session()).toMatchObject({ input_tokens: 1000, output_tokens: 80, total_tokens: 1080 })
  })

  it('重复事件（IPC+WS 双路同值）不双计', () => {
    const usage = { input_tokens: 1000, output_tokens: 50 }
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, usage)
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, usage)
    expect(session()).toMatchObject({ input_tokens: 1000, output_tokens: 50, total_tokens: 1050 })
  })

  it('多轮 tool loop（多个 message）逐次累加', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, output_tokens: 50 })
    applyStreamingMessageDeltaUsage(SESSION, MSG_B, { input_tokens: 1500, output_tokens: 70 })
    expect(session()).toMatchObject({ input_tokens: 2500, output_tokens: 120, total_tokens: 2620 })
  })
})

describe('§3 DONE 差额校正', () => {
  it('DONE 权威值 > 流式已加：只补差额', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, output_tokens: 50 })
    // BudgetTracker per-run 含流式看不到的部分（子 Agent / retry）
    applyDoneUsage(SESSION, 'trace-1', { input_tokens: 1300, output_tokens: 90 })
    expect(session()).toMatchObject({ input_tokens: 1300, output_tokens: 90, total_tokens: 1390 })
  })

  it('DONE 权威值 == 流式已加：不再追加', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, output_tokens: 50 })
    applyDoneUsage(SESSION, 'trace-1', { input_tokens: 1000, output_tokens: 50 })
    expect(session()).toMatchObject({ input_tokens: 1000, output_tokens: 50, total_tokens: 1050 })
  })

  it('同 trace_id 幂等：onDone 与 miscHandler 双达只应用一次', () => {
    applyDoneUsage(SESSION, 'trace-1', { input_tokens: 500, output_tokens: 20 })
    applyDoneUsage(SESSION, 'trace-1', { input_tokens: 500, output_tokens: 20 })
    expect(session()).toMatchObject({ input_tokens: 500, output_tokens: 20, total_tokens: 520 })
  })

  it('无流式累加（观察端中途加入等）：DONE 全额累加', () => {
    applyDoneUsage(SESSION, 'trace-1', { input_tokens: 800, output_tokens: 40 })
    expect(session()).toMatchObject({ input_tokens: 800, output_tokens: 40, total_tokens: 840 })
  })

  it('跨 run：DONE 后新 run 的流式从零累计，不受上一 run 影响', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, output_tokens: 50 })
    applyDoneUsage(SESSION, 'trace-1', { input_tokens: 1000, output_tokens: 50 })
    applyStreamingMessageDeltaUsage(SESSION, MSG_B, { input_tokens: 1200, output_tokens: 30 })
    applyDoneUsage(SESSION, 'trace-2', { input_tokens: 1200, output_tokens: 30 })
    expect(session()).toMatchObject({ input_tokens: 2200, output_tokens: 80, total_tokens: 2280 })
  })

  it('无 doneKey（历史云端路径）直接应用，不做幂等', () => {
    applyDoneUsage(SESSION, undefined, { input_tokens: 100, output_tokens: 10 })
    expect(session()).toMatchObject({ input_tokens: 100, output_tokens: 10, total_tokens: 110 })
  })
})

describe('§5 会话终态清理（无 DONE 的异常终止）', () => {
  it('run 无 DONE 终止 → 清理后下一 run 的 DONE 差额不被残留污染', () => {
    // Run1：流式加了 1000/50，但 daemon crash，DONE 永远不来
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, output_tokens: 50 })
    // lifecycle 终态（cleanupSessionOnTerminal）清理残留
    clearStreamTokenUsageForSession(SESSION)

    // Run2：正常跑完。若 Run1 残留未清，差额 = 1200 - (1000+1200) < 0 → 全漏加
    applyStreamingMessageDeltaUsage(SESSION, MSG_B, { input_tokens: 1200, output_tokens: 30 })
    applyDoneUsage(SESSION, 'trace-2', { input_tokens: 1200, output_tokens: 30 })

    // Run1 流式已加的 1000/50 保留（缓存单调），Run2 完整入账
    expect(session()).toMatchObject({ input_tokens: 2200, output_tokens: 80, total_tokens: 2280 })
  })

  it('正常路径（DONE 已消费）后清理是 no-op', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, output_tokens: 50 })
    applyDoneUsage(SESSION, 'trace-1', { input_tokens: 1000, output_tokens: 50 })
    clearStreamTokenUsageForSession(SESSION)
    expect(session()).toMatchObject({ input_tokens: 1000, output_tokens: 50, total_tokens: 1050 })
  })

  it('清理不影响 DONE 幂等键：重放旧 DONE 仍被拦', () => {
    applyDoneUsage(SESSION, 'trace-1', { input_tokens: 500, output_tokens: 20 })
    clearStreamTokenUsageForSession(SESSION)
    applyDoneUsage(SESSION, 'trace-1', { input_tokens: 500, output_tokens: 20 })
    expect(session()).toMatchObject({ input_tokens: 500, output_tokens: 20, total_tokens: 520 })
  })
})

describe('§4 placeholder 防御', () => {
  it('输入侧全 0 不写 usage_json（环不闪 0）', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 0, output_tokens: 0 })
    expect(message(MSG_A)?.usage_json).toBeUndefined()
    expect(session()).toMatchObject({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })
  })

  it('输入侧 0 但 output > 0（流式 partial）：不写 usage_json，output 增量照加', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 0, output_tokens: 30 })
    expect(message(MSG_A)?.usage_json).toBeUndefined()
    expect(session()).toMatchObject({ input_tokens: 0, output_tokens: 30, total_tokens: 30 })
  })
})

describe('§7 缓存实时累加（会话级 cache 分项，）', () => {
  it('流式：cache_read 单列累加，input 保持非 cache', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, {
      input_tokens: 8638,
      cache_read_input_tokens: 14336,
      output_tokens: 226,
    })
    expect(session()).toMatchObject({
      input_tokens: 8638,               // 非 cache
      cache_read_input_tokens: 14336,   // 单列
      output_tokens: 226,
      total_tokens: 8638 + 226,         // total 不含 cache
    })
  })

  it('cumulative 递增：同消息 cache 稳定，重复事件不双计', () => {
    const usage = { input_tokens: 8638, cache_read_input_tokens: 14336, output_tokens: 100 }
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, usage)
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, usage)
    expect(session()).toMatchObject({ input_tokens: 8638, cache_read_input_tokens: 14336 })
  })

  it('多消息（tool loop）：cache 逐条累加', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 20 })
    applyStreamingMessageDeltaUsage(SESSION, MSG_B, { input_tokens: 1500, cache_read_input_tokens: 6000, output_tokens: 30 })
    expect(session()).toMatchObject({
      input_tokens: 2500,
      cache_read_input_tokens: 11000,
    })
  })

  it('DONE 差额校正含 cache：只补 done − 流式已加', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, { input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 20 })
    // DONE 权威值含子 Agent/retry 看不到的部分
    applyDoneUsage(SESSION, 'trace-1', {
      input_tokens: 1200,
      cache_read_input_tokens: 5800,
      output_tokens: 40,
    })
    expect(session()).toMatchObject({
      input_tokens: 1200,
      cache_read_input_tokens: 5800,
      output_tokens: 40,
    })
  })

  it('cache_creation 也单列累加', () => {
    applyStreamingMessageDeltaUsage(SESSION, MSG_A, {
      input_tokens: 500,
      cache_creation_input_tokens: 2000,
      output_tokens: 10,
    })
    expect(session()).toMatchObject({
      input_tokens: 500,
      cache_creation_input_tokens: 2000,
    })
  })
})
