/**
 *  live chain（主进程）：SubagentManager scope lease → CLI thread lookup → open_tab scope。
 *
 * 不启动 Electron UI，但走真实 cli-context + SubagentManager 接线，覆盖：
 *   1. 子 Agent agent-* thread 绑定父会话 scope
 *   2. 前台 legacy scope 切换不串台
 *   3. 同 childId 重登记后，旧 unregister 不释放新 run 的 lease
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SubagentManager } from '@tabtin/agent-runtime'

import {
  acquireCLIWorkspaceScopeLease,
  acquireSubagentCLIWorkspaceScopeLease,
  buildSubagentThreadId,
  getCLIWorkspaceScopeKey,
  setCLIWorkspaceScopeKey,
} from '../cli-context'

describe('#8188 subagent scope live chain（主进程）', () => {
  const parentSession = '8a94eeef-e539-42e6-b17f-38dc214c181a'
  const parentScope = `conversation:${parentSession}`

  beforeEach(() => {
    setCLIWorkspaceScopeKey(null)
  })

  afterEach(() => {
    setCLIWorkspaceScopeKey(null)
  })

  it('SubagentManager + CLI lease：重登记后旧 unregister 不释放新 lease', () => {
    const parentLease = acquireCLIWorkspaceScopeLease(
      [`chat-session-${parentSession}`, parentSession],
      parentScope,
    )

    const mgr = new SubagentManager({
      parentThreadId: parentSession,
      parentScopeThreadIds: [`chat-session-${parentSession}`, parentSession],
      onChildThreadScope: ({ childId, parentScopeThreadIds }) => {
        const lease = acquireSubagentCLIWorkspaceScopeLease(childId, parentScopeThreadIds)
        return () => lease.release()
      },
    })

    const childId = 'sub-live-1'
    const childThreadId = buildSubagentThreadId(childId)

    const unregisterQueued = mgr.registerRun(childId, new AbortController(), { state: 'queued' })
    expect(getCLIWorkspaceScopeKey(childThreadId)).toBe(parentScope)

    const unregisterActive = mgr.registerRun(childId, new AbortController(), { state: 'active' })
    expect(getCLIWorkspaceScopeKey(childThreadId)).toBe(parentScope)

    // 模拟 queued finally 晚到：不应释放 active run 的 lease。
    unregisterQueued()
    expect(getCLIWorkspaceScopeKey(childThreadId)).toBe(parentScope)

    setCLIWorkspaceScopeKey('conversation:foreground-task-B')
    expect(getCLIWorkspaceScopeKey()).toBe('conversation:foreground-task-B')
    expect(getCLIWorkspaceScopeKey(childThreadId)).toBe(parentScope)

    unregisterActive()
    expect(getCLIWorkspaceScopeKey(childThreadId)).toBeNull()

    parentLease.release()
  })

  it('open_tab scope 解析：agent-* thread 读父 scope，无 thread 时不读 legacy', () => {
    const parentLease = acquireCLIWorkspaceScopeLease([parentSession], parentScope)
    const subLease = acquireSubagentCLIWorkspaceScopeLease('sub-live-2', [parentSession])
    const childThreadId = buildSubagentThreadId('sub-live-2')

    setCLIWorkspaceScopeKey('conversation:other-task')

    // 与 FrontendActionBridge open_tab 一致：有 thread 才查 lease；无 thread 不用 legacy。
    const resolveOpenTabScope = (threadId?: string | null) =>
      threadId ? getCLIWorkspaceScopeKey(threadId) : null

    expect(resolveOpenTabScope(childThreadId)).toBe(parentScope)
    expect(resolveOpenTabScope(undefined)).toBeNull()
    expect(getCLIWorkspaceScopeKey()).toBe('conversation:other-task')

    subLease.release()
    parentLease.release()
  })
})
