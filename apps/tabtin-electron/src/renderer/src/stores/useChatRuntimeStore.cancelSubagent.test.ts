/**
 * useChatRuntimeStore.cancelSubagentRun — W5-a 子 Agent 取消端到端链路（renderer 侧）。
 *
 * 守的不变量：
 *   ① 本地宿主会话：window.tabtin.agentEngine.cancelSubagent（IPC）命中即收工。
 *   ② daemon / 远控会话：renderer 仍只发 IPC，由主进程 agent-host 代发
 *      `subagent.cancel {session_id, child_id}` 并返回是否 accepted。
 *   ③ agent-host 拒绝 / 失败：不落 cancelled，但清 in-flight「取消中」标记让用户可重试。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const gatewayRequest = vi.fn()

vi.mock('../services/chatApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chatApi')>()
  return {
    ...actual,
    getChatClient: () => ({
      getGateway: () => ({ request: gatewayRequest }),
    }),
  }
})

import { useChatRuntimeStore } from './useChatRuntimeStore'

const SESSION = 'sess-cancel-1'
const CHILD = 'child-uuid-1'

function seedRun(): void {
  useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
    subagentRunId: CHILD,
    status: 'running',
  })
}

function currentRunStatus(): string | undefined {
  return useChatRuntimeStore
    .getState()
    .subagentRunsBySessionId[SESSION]?.find(r => r.subagentRunId === CHILD)?.status
}

function runStatus(subagentRunId: string): string | undefined {
  return useChatRuntimeStore
    .getState()
    .subagentRunsBySessionId[SESSION]?.find(r => r.subagentRunId === subagentRunId)?.status
}

describe('useChatRuntimeStore.markSubagentRunTerminalForSession', () => {
  beforeEach(() => {
    useChatRuntimeStore.setState({ subagentRunsBySessionId: {} })
  })

  it('把活跃态子 Agent 收敛到 completed', () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: CHILD,
      status: 'running',
      stepCount: 2,
    })

    useChatRuntimeStore
      .getState()
      .markSubagentRunTerminalForSession(SESSION, CHILD, 'completed', 'child_stream')

    const run = useChatRuntimeStore
      .getState()
      .subagentRunsBySessionId[SESSION]?.find(r => r.subagentRunId === CHILD)
    expect(run).toMatchObject({
      subagentRunId: CHILD,
      status: 'completed',
      stepCount: 2,
    })
    expect(typeof run?.endedAt).toBe('number')
  })

  it('不覆盖已有 failed/cancelled/completed 终态', () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: 'child-failed',
      status: 'failed',
    })
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: 'child-cancelled',
      status: 'cancelled',
    })
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION, {
      subagentRunId: 'child-completed',
      status: 'completed',
    })

    const store = useChatRuntimeStore.getState()
    store.markSubagentRunTerminalForSession(SESSION, 'child-failed', 'completed', 'child_stream')
    store.markSubagentRunTerminalForSession(SESSION, 'child-cancelled', 'completed', 'child_stream')
    store.markSubagentRunTerminalForSession(SESSION, 'child-completed', 'failed', 'metadata')

    expect(runStatus('child-failed')).toBe('failed')
    expect(runStatus('child-cancelled')).toBe('cancelled')
    expect(runStatus('child-completed')).toBe('completed')
  })

  it('没有对应 run 时不创建新卡片状态', () => {
    useChatRuntimeStore
      .getState()
      .markSubagentRunTerminalForSession(SESSION, 'missing-run', 'completed', 'child_stream')

    expect(useChatRuntimeStore.getState().subagentRunsBySessionId[SESSION]).toBeUndefined()
  })
})

describe('useChatRuntimeStore.cancelSubagentRun', () => {
  beforeEach(() => {
    gatewayRequest.mockReset()
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {},
      subagentCancellingByRunId: {},
    })
  })

  afterEach(() => {
    delete (window as { tabtin?: unknown }).tabtin
  })

  it('① 本地 IPC 命中：落 cancelled，清 in-flight', async () => {
    seedRun()
    const cancelSubagent = vi.fn().mockResolvedValue(true)
    ;(window as unknown as { tabtin: unknown }).tabtin = { agentEngine: { cancelSubagent } }

    await useChatRuntimeStore.getState().cancelSubagentRun(CHILD)

    expect(cancelSubagent).toHaveBeenCalledWith({ childId: CHILD, sessionId: SESSION })
    expect(gatewayRequest).not.toHaveBeenCalled()
    expect(currentRunStatus()).toBe('cancelled')
    expect(useChatRuntimeStore.getState().subagentCancellingByRunId[CHILD]).toBeUndefined()
  })

  it('② 远控取消仍只走 agent-host IPC，accepted 后落 cancelled', async () => {
    seedRun()
    const cancelSubagent = vi.fn().mockResolvedValue(true)
    ;(window as unknown as { tabtin: unknown }).tabtin = {
      agentEngine: { cancelSubagent },
    }

    await useChatRuntimeStore.getState().cancelSubagentRun(CHILD)

    expect(cancelSubagent).toHaveBeenCalledWith({ childId: CHILD, sessionId: SESSION })
    expect(gatewayRequest).not.toHaveBeenCalled()
    expect(currentRunStatus()).toBe('cancelled')
    expect(useChatRuntimeStore.getState().subagentCancellingByRunId[CHILD]).toBeUndefined()
  })

  it('② 纯 observer 端缺少 agentEngine IPC 时不走 renderer gateway', async () => {
    seedRun()
    ;(window as unknown as { tabtin: unknown }).tabtin = { agentEngine: {} }

    await useChatRuntimeStore.getState().cancelSubagentRun(CHILD)

    expect(gatewayRequest).not.toHaveBeenCalled()
    expect(currentRunStatus()).toBe('running')
  })

  it('③ agent-host 拒绝 → 不落 cancelled，但清 in-flight 让用户可重试', async () => {
    seedRun()
    const cancelSubagent = vi.fn().mockResolvedValue(false)
    ;(window as unknown as { tabtin: unknown }).tabtin = {
      agentEngine: { cancelSubagent },
    }

    await useChatRuntimeStore.getState().cancelSubagentRun(CHILD)

    expect(cancelSubagent).toHaveBeenCalledWith({ childId: CHILD, sessionId: SESSION })
    expect(gatewayRequest).not.toHaveBeenCalled()
    expect(currentRunStatus()).toBe('running')
    expect(useChatRuntimeStore.getState().subagentCancellingByRunId[CHILD]).toBeUndefined()
  })
})

describe('useChatRuntimeStore interrupted message recovery', () => {
  const sessionId = 'session-interrupted-input'

  beforeEach(() => {
    useChatRuntimeStore.setState({
      activeSubmittedMessageBySessionId: {},
      pendingInterruptedMessageBySessionId: {},
    })
  })

  it('keeps the original submission snapshot until the composer consumes it', () => {
    useChatRuntimeStore.getState().setActiveSubmittedMessageForSession(sessionId, {
      clientMessageId: 'client-message-1',
      localMessageId: 'temp-user-1',
      message: '请重新整理这份方案',
      attachments: [{
        id: 'file-1',
        filename: 'brief.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        type: 'file',
        fileId: 'file-1',
      }],
      contextBlocks: [{ type: 'document', document_id: 'doc-1' }],
    })
    const recovery = useChatRuntimeStore
      .getState()
      .moveActiveSubmittedMessageToInterruptedRecovery(sessionId)

    expect(recovery).toMatchObject({
      clientMessageId: 'client-message-1',
      localMessageId: 'temp-user-1',
      message: '请重新整理这份方案',
      attachments: [{ filename: 'brief.pdf' }],
      contextBlocks: [{ type: 'document', document_id: 'doc-1' }],
    })
    expect(
      useChatRuntimeStore.getState().activeSubmittedMessageBySessionId[sessionId],
    ).toBeUndefined()

    expect(
      useChatRuntimeStore.getState().consumeInterruptedMessageRecovery(sessionId),
    ).toMatchObject({
      message: '请重新整理这份方案',
    })
    expect(
      useChatRuntimeStore.getState().pendingInterruptedMessageBySessionId[sessionId],
    ).toBeUndefined()
  })

  it('does not let a superseded turn clear a newer submission snapshot', () => {
    useChatRuntimeStore.getState().setActiveSubmittedMessageForSession(sessionId, {
      clientMessageId: 'new-client-message',
      localMessageId: 'temp-user-new',
      message: '新的输入',
    })

    useChatRuntimeStore
      .getState()
      .clearActiveSubmittedMessage(sessionId, 'old-client-message')

    expect(
      useChatRuntimeStore.getState().activeSubmittedMessageBySessionId[sessionId],
    ).toMatchObject({ clientMessageId: 'new-client-message' })
  })
})
