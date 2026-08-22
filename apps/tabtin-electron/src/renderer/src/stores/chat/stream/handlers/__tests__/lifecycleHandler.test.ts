/**
 * lifecycleHandler 单测（widget 治理 Wave 2.5b §任务 2 + §任务 3）
 *
 * 关键验收：
 *   - 任务 2：phase=end/error/terminated 时调 clearToolCallArgsBuffers
 *     时**传具体 reason**（session_ended / session_errored / session_terminated），
 *     不是默认值 —— sentinel 协议显式区分
 *   - 任务 3：phase=turn_start / turn_end 时调 gcStaleToolCallArgsBuffers
 *     —— 多 turn 不累积
 *
 * 测试策略：lifecycleHandler 依赖大量 store action，full mock 代价大。
 * 用静态分析守住"关键调用存在 + reason 路由正确"——比凭空写假 store
 * 模拟更稳。
 *  phase=start 行为测见 lifecycleHandler.startDelivery.test.ts。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { findAssistantAfterPendingUser } from '../../../checkpoint/handlers/checkpointAnchor'

function msg(overrides: Partial<ChatMessage> & { id: string; role: ChatMessage['role'] }): ChatMessage {
  return {
    content: '',
    created_at: '2026-06-23T00:00:00.000Z',
    ...overrides,
  } as ChatMessage
}

describe('lifecycleHandler — checkpoint anchor selection', () => {
  it('只选择本轮 user 之后的 assistant，不绑定上一轮旧 assistant', () => {
    const previousAssistant = msg({ id: 'assistant-prev', role: 'assistant' })
    const currentUser = msg({
      id: 'user-server',
      role: 'user',
      metadata: { client_event_id: 'client-current' },
    })
    const currentAssistant = msg({ id: 'assistant-current', role: 'assistant' })

    expect(findAssistantAfterPendingUser(
      [msg({ id: 'user-prev', role: 'user' }), previousAssistant],
      {
        baselineHashPromise: Promise.resolve(undefined),
        userClientMessageId: 'client-current',
        userLocalMessageId: 'temp-user-current',
      },
    )).toBeNull()

    expect(findAssistantAfterPendingUser(
      [msg({ id: 'user-prev', role: 'user' }), previousAssistant, currentUser, currentAssistant],
      {
        baselineHashPromise: Promise.resolve(undefined),
        userClientMessageId: 'client-current',
        userLocalMessageId: 'temp-user-current',
      },
    )).toBe(currentAssistant)
  })

  it('支持 server user id 和 legacy client_message_id 匹配本轮 user', () => {
    const assistant = msg({ id: 'assistant-current', role: 'assistant' })
    expect(findAssistantAfterPendingUser(
      [msg({ id: 'user-server', role: 'user' }), assistant],
      {
        baselineHashPromise: Promise.resolve(undefined),
        userServerMessageId: 'user-server',
      },
    )).toBe(assistant)

    expect(findAssistantAfterPendingUser(
      [
        msg({
          id: 'user-server-legacy',
          role: 'user',
          metadata: { client_message_id: 'client-legacy' },
        }),
        assistant,
      ],
      {
        baselineHashPromise: Promise.resolve(undefined),
        userClientMessageId: 'client-legacy',
      },
    )).toBe(assistant)
  })

  it('忽略 tool_artifact assistant，checkpoint anchor 只落到主 LLM assistant', () => {
    const llmAssistant = msg({ id: 'assistant-llm', role: 'assistant', message_kind: 'llm' })
    const artifactAssistant = msg({
      id: 'assistant-artifact',
      role: 'assistant',
      message_kind: 'tool_artifact',
    })

    expect(findAssistantAfterPendingUser(
      [
        msg({
          id: 'user-server',
          role: 'user',
          metadata: { client_event_id: 'client-current' },
        }),
        llmAssistant,
        artifactAssistant,
      ],
      {
        baselineHashPromise: Promise.resolve(undefined),
        userClientMessageId: 'client-current',
      },
    )).toBe(llmAssistant)
  })
})

describe('lifecycleHandler — 任务 2 sentinel reason 路由', () => {
  it('phase=end/error/terminated 分别路由 session_ended / session_errored / session_terminated', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../lifecycleHandler.ts'),
      'utf-8',
    )

    // 关键 token 1：clearToolCallArgsBuffers 接受第二个参数 sentinelReason
    expect(content).toMatch(/clearToolCallArgsBuffers\(sessionId,\s*sentinelReason\)/)

    // 关键 token 2：reason 路由表 —— phase=error → session_errored
    expect(content).toMatch(/phase\s*===\s*'error'\s*\?\s*'session_errored'/)
    // 关键 token 3：phase=terminated → session_terminated
    expect(content).toMatch(/phase\s*===\s*'terminated'\s*\?\s*'session_terminated'/)
    // 关键 token 4：默认（即 phase=end / cancelled）→ session_ended
    expect(content).toMatch(/'session_ended'/)
  })
})

describe('lifecycleHandler — 任务 3 turn 边界 gc 调用', () => {
  it('phase=turn_end 时调 gcStaleToolCallArgsBuffers', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../lifecycleHandler.ts'),
      'utf-8',
    )

    // turn_end 分支必须含 gc 调用 —— 这是任务 3 的核心
    const turnEndIdx = content.indexOf("phase === 'turn_end'")
    expect(turnEndIdx).toBeGreaterThan(0)
    const turnEndBlock = content.slice(turnEndIdx, turnEndIdx + 1500)
    expect(turnEndBlock).toContain('gcStaleToolCallArgsBuffers(sessionId)')
  })

  it('phase=turn_start 时也调 gc（兜底：上一轮 turn_end 未 emit 的极端 case）', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../lifecycleHandler.ts'),
      'utf-8',
    )

    const turnStartIdx = content.indexOf("phase === 'turn_start'")
    expect(turnStartIdx).toBeGreaterThan(0)
    // turn_start 块到下一个 'phase ===' 之间
    const nextPhaseIdx = content.indexOf("phase ===", turnStartIdx + 1)
    expect(nextPhaseIdx).toBeGreaterThan(turnStartIdx)
    const turnStartBlock = content.slice(turnStartIdx, nextPhaseIdx)
    expect(turnStartBlock).toContain('gcStaleToolCallArgsBuffers(sessionId)')
  })

  it('gcStaleToolCallArgsBuffers 是 import 进 lifecycleHandler 的（绑定真实实现）', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../lifecycleHandler.ts'),
      'utf-8',
    )

    expect(content).toMatch(
      /import\s+\{[^}]*gcStaleToolCallArgsBuffers[^}]*\}\s+from\s+['"]\.\/toolCallArgsBufferStore['"]/,
    )
  })
})

// ─── 自修复（三视角 Review 共发现）：
// idle_timeout / session_interrupted 路径必须清 args buffer + 发 sentinel
// reason='session_disconnected'，否则 RichWidget 会卡在 isStreaming=true，
// 且 buffer 跨 turn 累积破坏任务 3 内存防线。
describe('lifecycleHandler — 自修复：idle_timeout / session_interrupted 接通 args buffer 清理', () => {
  it('phase=idle_timeout 时调 clearToolCallArgsBuffers reason=session_disconnected', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../lifecycleHandler.ts'),
      'utf-8',
    )

    const idleIdx = content.indexOf("phase === 'idle_timeout'")
    expect(idleIdx).toBeGreaterThan(0)
    const idleBlock = content.slice(idleIdx, idleIdx + 1500)
    // 关键：必须含 clearToolCallArgsBuffers + 'session_disconnected' reason
    expect(idleBlock).toContain("clearToolCallArgsBuffers(sessionId, 'session_disconnected')")
  })

  it('phase=idle_timeout 时复用 cleanupSessionOnTerminal 收尾 todo/run state', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../lifecycleHandler.ts'),
      'utf-8',
    )

    const idleIdx = content.indexOf("phase === 'idle_timeout'")
    expect(idleIdx).toBeGreaterThan(0)
    const idleBlock = content.slice(idleIdx, idleIdx + 1500)
    expect(idleBlock).toContain('cleanupSessionOnTerminal({')
    expect(idleBlock).toContain("status: 'cancelled'")
    expect(idleBlock).toContain('removeStreamingSession')
  })

  it('phase=session_interrupted 时调 clearToolCallArgsBuffers reason=session_disconnected', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../lifecycleHandler.ts'),
      'utf-8',
    )

    const interruptedIdx = content.indexOf("phase === 'session_interrupted'")
    expect(interruptedIdx).toBeGreaterThan(0)
    const interruptedBlock = content.slice(interruptedIdx, interruptedIdx + 1500)
    expect(interruptedBlock).toContain("clearToolCallArgsBuffers(sessionId, 'session_disconnected')")
  })

  it('phase=session_interrupted 时复用 cleanupSessionOnTerminal 收尾 todo/run state', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../lifecycleHandler.ts'),
      'utf-8',
    )

    const interruptedIdx = content.indexOf("phase === 'session_interrupted'")
    expect(interruptedIdx).toBeGreaterThan(0)
    const interruptedBlock = content.slice(interruptedIdx, interruptedIdx + 1500)
    expect(interruptedBlock).toContain('cleanupSessionOnTerminal({')
    expect(interruptedBlock).toContain("status: 'cancelled'")
    expect(interruptedBlock).toContain('removeStreamingSession')
  })
})

// 注：「终态后 freshSession 双轨写入」的真断言走两路覆盖：
//   - utility 自身：`utils/chatSessionTokenUsage.test.ts` 验剔除 / 单调 / SSoT
//     invariant；
//   - 调用方：`stores/chat/stream/handlers/__tests__/syncMessageContent.test.ts` 验 derived
//     content 写入；`sessionCleanup.test.ts` 验 cancel/error 路径调 helper。
//
// 静态分析风格的伪断言（regex match 源码字符串）这里刻意不再加——重构
// 时不影响行为却 fail 测试，价值低噪音高。后续给 lifecycleHandler 加运行时
// mock 测试时一起补上"phase=end 真触发 GET + 真写缓存"的端到端断言。
