import { describe, expect, it } from 'vitest'
import type { QueryRequest } from '../electron-agent-types'
import { buildAgentWorktreeContinuation } from '../agent-worktree-continuation'

function sourceRequest(): QueryRequest {
  return {
    prompt: '原始用户任务',
    displayMessage: '原始用户任务',
    threadId: 'session-1',
    businessThreadId: 'business-1',
    runId: 'run-old',
    taskId: 'task-old',
    relaySessionId: 'relay-old',
    clientMessageId: 'message-old',
    interruptActive: true,
    attachments: [{ type: 'file', filename: 'old.txt', url: 'file:///tmp/old.txt' }],
    userMessageBlocks: [{ type: 'text', text: 'old' }],
    history: [{ role: 'user', content: 'old' }],
    pendingSingleHitlSerialized: [{
      kind: 'ask_choice',
      requestKey: 'old-hitl',
      status: 'pending',
    }],
    boundCodeRoot: '/repo/main',
    boundCodeRootRevision: 2,
    workingDir: '/repo/main',
  }
}

describe('buildAgentWorktreeContinuation', () => {
  it('成功时在同一 thread 续跑新根，并清除上一轮一次性现场', () => {
    const continuation = buildAgentWorktreeContinuation(
      sourceRequest(),
      {
        previousRootPath: '/repo/main',
        targetRootPath: '/repo/wt',
        branch: 'feat/10498',
      },
      { success: true, rootPath: '/repo/wt', revision: 3 },
      'message-next',
    )

    expect(continuation).toMatchObject({
      threadId: 'session-1',
      businessThreadId: 'business-1',
      relaySessionId: 'relay-old',
      triggeredBy: 'push-notification',
      clientMessageId: 'message-next',
      interruptActive: false,
      boundCodeRoot: '/repo/wt',
      boundCodeRootRevision: 3,
      workingDir: '/repo/wt',
    })
    expect(continuation.prompt).toContain('分支：feat/10498')
    expect(continuation.displayMessage).toBe(
      '已切换代码根到 ` wt `，Agent 正在同一对话中继续任务。',
    )
    expect(continuation.displayMessage).not.toContain('/repo/wt')
    expect(continuation.runId).toBeUndefined()
    expect(continuation.taskId).toBeUndefined()
    expect(continuation.attachments).toBeUndefined()
    expect(continuation.history).toBeUndefined()
    expect(continuation.pendingSingleHitlSerialized).toBeUndefined()
  })

  it('提交失败时仍在同一 thread 续跑，但保持原代码根', () => {
    const continuation = buildAgentWorktreeContinuation(
      sourceRequest(),
      { previousRootPath: '/repo/main', targetRootPath: '/repo/wt' },
      { success: false, error: 'sidecar write failed' },
      'message-next',
    )

    expect(continuation.boundCodeRoot).toBe('/repo/main')
    expect(continuation.workingDir).toBe('/repo/main')
    expect(continuation.prompt).toContain('sidecar write failed')
  })

  it.each([
    ['/Users/me/worktrees/TabTin/wt-feat', '` wt-feat `'],
    ['C:\\Users\\me\\AppData\\Local\\TabTin\\worktrees\\wt-feat', '` wt-feat `'],
    ['/Users/me/worktrees/root`name', '`` root`name ``'],
  ])('系统消息把代码根 %s 显示为不可点击的紧凑名称', (rootPath, label) => {
    const continuation = buildAgentWorktreeContinuation(
      sourceRequest(),
      { previousRootPath: '/repo/main', targetRootPath: rootPath },
      { success: true, rootPath, revision: 3 },
      'message-next',
    )

    expect(continuation.displayMessage).toContain(label)
    expect(continuation.displayMessage).not.toContain(rootPath)
    expect(continuation.prompt).toContain(`新代码根：${rootPath}`)
  })
})
