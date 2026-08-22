import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setSessionAgentMode: vi.fn(),
  updateSession: vi.fn(),
}))

vi.mock('../sessionAgentMode', () => ({
  setSessionAgentMode: (...args: unknown[]) => mocks.setSessionAgentMode(...args),
}))

import {
  bindDraftSessionToMessage,
  getDraftSessionBySessionId,
  rehomeDraftSessionForMessage,
} from '../draftSession'
import {
  getDraftMessageById,
  getDraftMessageByScopeKey,
  isDraftMessageActive,
  recordDraftAgentIntent,
  recordDraftModeIntent,
  resetAllDraftMessages,
  mutateDraftMessageMetadata,
  peekDraftAgentIntent,
  peekDraftContextTierIntent,
  peekDraftModelIntent,
  peekDraftModelParamOverrides,
} from '../draftMessage'
import {
  __getAgentSyncTailSizeForTests,
  __resetDraftMessageSessionCoordinatorForTests,
  beginDraftMessageSession,
  cancelDraftMessageSessionByScopeKey,
  commitDraftMessageConfigBeforeSend,
  completeDraftMessageSend,
  leaveDraftMessagePage,
  resetDraftMessageSessionState,
  setAbandonedEmptySessionDiscarder,
  setDraftSessionModeApplier,
  syncDraftAgentIntent,
  syncDraftModeIntent,
  syncDraftModelIntent,
  syncModeIntentForBoundSession,
  waitForDraftAgentSync,
} from '../draftMessageSessionCoordinator'

const SCOPE_A = 'conversation:draft:workspace-a'
const SCOPE_B = 'conversation:draft:workspace-b'
const SCOPE_1 = 'conversation:draft:workspace-1'

const patchSessionAgent = (sessionId: string, agentId: string) =>
  mocks.updateSession(sessionId, { agent_id: agentId })

describe('draftMessage ( draftScopeKey lifecycle)', () => {
  beforeEach(() => {
    __resetDraftMessageSessionCoordinatorForTests()
    setDraftSessionModeApplier((...args) => mocks.setSessionAgentMode(...args))
    mocks.setSessionAgentMode.mockReset()
    mocks.updateSession.mockReset().mockResolvedValue({
      id: 'sess-hidden',
      agent_id: 'agent-2',
    })
    beginDraftMessageSession(SCOPE_1, {
      organizationId: 'org-1',
      executionWorkspaceId: 'ws-1',
      agentId: 'agent-draft',
    })
  })

  it('A. 领域模型无 spaceId；按 draftScopeKey 隔离', () => {
    const ep = getDraftMessageByScopeKey(SCOPE_1)!
    expect(ep).toMatchObject({
      draftScopeKey: SCOPE_1,
      organizationId: 'org-1',
      executionWorkspaceId: 'ws-1',
    })
    expect(ep).not.toHaveProperty('spaceId')
    expect(Object.keys(ep)).not.toContain('spaceId')
    expect(Object.keys(ep)).toEqual(
      expect.arrayContaining([
        'draftMessageId',
        'draftScopeKey',
        'organizationId',
        'executionWorkspaceId',
        'revision',
      ]),
    )
    expect(ep).not.toHaveProperty('boundSessionIds')
  })

  it('beginDraftMessageSession 生成稳定 token，二次 begin 取消旧 episode', () => {
    const first = getDraftMessageByScopeKey(SCOPE_1)!
    const second = beginDraftMessageSession(SCOPE_1)
    expect(second.draftMessageId).not.toBe(first.draftMessageId)
    expect(getDraftMessageByScopeKey(SCOPE_1)?.draftMessageId).toBe(second.draftMessageId)
    expect(getDraftMessageById(first.draftMessageId)).toBeUndefined()
  })

  it('草稿切 plan：写回绑定 session 的 per-session mode', () => {
    const sessionId = syncDraftModeIntent('plan', {
      draftScopeKey: SCOPE_1,
      isUiDraft: true,
      hiddenSessionId: 'sess-hidden',
    })
    expect(sessionId).toBe('sess-hidden')
    expect(getDraftMessageByScopeKey(SCOPE_1)).toMatchObject({
      mode: 'plan',
      agentId: 'agent-draft',
    })
    expect(mocks.setSessionAgentMode).toHaveBeenCalledWith('sess-hidden', 'plan')
  })

  it('#7868 草稿切模型：记录意图并返回 hidden session', () => {
    const sessionId = syncDraftModelIntent('model-doubao', {
      draftScopeKey: SCOPE_1,
      isUiDraft: true,
      hiddenSessionId: 'sess-hidden',
    })
    expect(sessionId).toBe('sess-hidden')
    expect(peekDraftModelIntent(SCOPE_1)).toBe('model-doubao')
    expect(getDraftMessageByScopeKey(SCOPE_1)).toMatchObject({
      modelId: 'model-doubao',
    })
  })

  it('#7868 草稿切模型+档位：一并写入 episode', () => {
    syncDraftModelIntent('model-doubao', {
      draftScopeKey: SCOPE_1,
      isUiDraft: true,
      hiddenSessionId: 'sess-hidden',
    }, { contextTierId: 'tier-long' })
    expect(getDraftMessageByScopeKey(SCOPE_1)).toMatchObject({
      modelId: 'model-doubao',
      contextTierId: 'tier-long',
    })
  })

  it('草稿思考强度写入 episode，并支持恢复默认值', () => {
    syncDraftModelIntent('model-doubao', {
      draftScopeKey: SCOPE_1,
      isUiDraft: true,
    }, {
      controlChange: { key: 'reasoning_effort', value: 'high' },
    })
    expect(peekDraftModelParamOverrides(SCOPE_1)).toEqual({
      reasoning_effort: 'high',
    })

    syncDraftModelIntent('model-doubao', {
      draftScopeKey: SCOPE_1,
      isUiDraft: true,
    }, {
      controlChange: { key: 'reasoning_effort', value: null },
    })
    expect(peekDraftModelParamOverrides(SCOPE_1)).toBeNull()
  })

  it('#7868 mutateDraftMessageMetadata：换执行 Workspace 不销毁 Mode/Agent/Model', () => {
    recordDraftModeIntent(SCOPE_1, 'plan')
    recordDraftAgentIntent(SCOPE_1, 'agent-x')
    syncDraftModelIntent('model-doubao', {
      draftScopeKey: SCOPE_1,
      isUiDraft: true,
    }, { contextTierId: 'tier-long' })
    const before = getDraftMessageByScopeKey(SCOPE_1)!
    const next = mutateDraftMessageMetadata(SCOPE_1, {
      executionWorkspaceId: 'exec-ws-c',
      organizationId: 'org-1',
    })
    expect(next?.draftMessageId).toBe(before.draftMessageId)
    expect(next?.executionWorkspaceId).toBe('exec-ws-c')
    expect(next?.mode).toBe('plan')
    expect(peekDraftAgentIntent(SCOPE_1)).toBe('agent-x')
    expect(peekDraftModelIntent(SCOPE_1)).toBe('model-doubao')
    expect(peekDraftContextTierIntent(SCOPE_1)).toBe('tier-long')
  })

  it('C. local-pending 等待中 Mode A→B：写回同一 episode，最终 commit 用 B', async () => {
    const ep = getDraftMessageByScopeKey(SCOPE_1)!
    bindDraftSessionToMessage(SCOPE_1, 'local-pending-1', { phase: 'sending' })
    syncModeIntentForBoundSession('local-pending-1', 'ask')
    syncModeIntentForBoundSession('local-pending-1', 'plan')
    expect(getDraftMessageByScopeKey(SCOPE_1)?.mode).toBe('plan')
    expect(getDraftMessageByScopeKey(SCOPE_1)?.draftMessageId).toBe(ep.draftMessageId)

    rehomeDraftSessionForMessage('local-pending-1', 'sess-real')
    mocks.updateSession.mockResolvedValue({ id: 'sess-real', agent_id: 'agent-draft' })
    const result = await commitDraftMessageConfigBeforeSend({
      sessionId: 'sess-real',
      getSession: () => ({ id: 'sess-real', agent_id: 'agent-draft' }),
      updateSessionInCaches: vi.fn(),
      patchSessionAgent,
    })
    expect(result).toMatchObject({ ok: true, mode: 'plan' })
    expect(mocks.setSessionAgentMode).toHaveBeenCalledWith('sess-real', 'plan')
    expect(getDraftMessageById(ep.draftMessageId)).toBeDefined()
    expect(getDraftSessionBySessionId('sess-real')?.status).toBe('pending')

    completeDraftMessageSend('sess-real', true)

    expect(getDraftMessageById(ep.draftMessageId)).toBeUndefined()
    expect(getDraftSessionBySessionId('sess-real')).toMatchObject({
      draftMessageId: ep.draftMessageId,
      status: 'claimed',
    })
  })

  it('发送未被 Host 接纳时保留 DraftMessage 供重试或离页清理', async () => {
    const draftMessage = getDraftMessageByScopeKey(SCOPE_1)!
    bindDraftSessionToMessage(SCOPE_1, 'sess-hidden', { phase: 'sending' })

    await commitDraftMessageConfigBeforeSend({
      sessionId: 'sess-hidden',
      getSession: () => ({ id: 'sess-hidden' }),
      updateSessionInCaches: vi.fn(),
      patchSessionAgent,
    })
    completeDraftMessageSend('sess-hidden', false)

    expect(getDraftMessageById(draftMessage.draftMessageId)).toBeDefined()
    expect(getDraftSessionBySessionId('sess-hidden')).toMatchObject({
      status: 'pending',
      phase: 'open',
    })
  })

  it('切历史 cancel 后历史 session 不 PATCH', async () => {
    bindDraftSessionToMessage(SCOPE_1, 'local-pending-1', { phase: 'sending' })
    recordDraftModeIntent(SCOPE_1, 'plan')
    recordDraftAgentIntent(SCOPE_1, 'agent-x')
    cancelDraftMessageSessionByScopeKey(SCOPE_1)

    const result = await commitDraftMessageConfigBeforeSend({
      sessionId: 'sess-historical',
      getSession: () => ({ id: 'sess-historical', agent_id: 'agent-old' }),
      updateSessionInCaches: vi.fn(),
      patchSessionAgent,
    })
    expect(result).toEqual({ ok: true, applied: false })
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it('G. 仅显式取消清理消息草稿与会话接管', async () => {
    recordDraftModeIntent(SCOPE_1, 'plan')
    recordDraftAgentIntent(SCOPE_1, 'agent-2')
    bindDraftSessionToMessage(SCOPE_1, 'sess-hidden')
    expect(getDraftMessageByScopeKey(SCOPE_1)?.mode).toBe('plan')

    mocks.updateSession.mockResolvedValue({ id: 'sess-hidden', agent_id: 'agent-2' })
    const result = await commitDraftMessageConfigBeforeSend({
      sessionId: 'sess-hidden',
      getSession: () => ({ id: 'sess-hidden', agent_id: 'agent-old' }),
      updateSessionInCaches: vi.fn(),
      patchSessionAgent,
    })
    expect(result).toMatchObject({ ok: true, mode: 'plan', agentId: 'agent-2' })
  })

  it('cancel 才真正销毁 episode intent', () => {
    recordDraftModeIntent(SCOPE_1, 'plan')
    cancelDraftMessageSessionByScopeKey(SCOPE_1)
    expect(getDraftMessageByScopeKey(SCOPE_1)).toBeUndefined()
  })

  it('#7898 cancel 时丢弃已绑定的空预建 session', () => {
    const discard = vi.fn()
    setAbandonedEmptySessionDiscarder(discard)
    bindDraftSessionToMessage(SCOPE_1, 'sess-empty')
    cancelDraftMessageSessionByScopeKey(SCOPE_1)
    expect(discard).toHaveBeenCalledWith({
      sessionIds: ['sess-empty'],
      reason: 'draft_cancel',
      draftSessionPhase: 'open',
    })
  })

  it('#7898 sending 阶段 cancel 仍会通知 discarder（由 discarder 按 phase 保留）', () => {
    const discard = vi.fn()
    setAbandonedEmptySessionDiscarder(discard)
    bindDraftSessionToMessage(SCOPE_1, 'sess-empty', { phase: 'sending' })
    cancelDraftMessageSessionByScopeKey(SCOPE_1)
    expect(discard).toHaveBeenCalledWith({
      sessionIds: ['sess-empty'],
      reason: 'draft_cancel',
      draftSessionPhase: 'sending',
    })
  })

  it('#7898 cancel 按各 DraftSession 的 phase 分组清理', () => {
    const discard = vi.fn()
    setAbandonedEmptySessionDiscarder(discard)
    bindDraftSessionToMessage(SCOPE_1, 'sess-open')
    bindDraftSessionToMessage(SCOPE_1, 'sess-sending', { phase: 'sending' })

    cancelDraftMessageSessionByScopeKey(SCOPE_1)

    expect(getDraftSessionBySessionId('sess-open')?.status).toBe('released')
    expect(getDraftSessionBySessionId('sess-sending')?.status).toBe('pending')
    expect(discard).toHaveBeenNthCalledWith(1, {
      sessionIds: ['sess-open'],
      reason: 'draft_cancel',
      draftSessionPhase: 'open',
    })
    expect(discard).toHaveBeenNthCalledWith(2, {
      sessionIds: ['sess-sending'],
      reason: 'draft_cancel',
      draftSessionPhase: 'sending',
    })
  })

  it('#7898 离开页面立即清理 open 预建会话', () => {
    const discard = vi.fn()
    setAbandonedEmptySessionDiscarder(discard)
    bindDraftSessionToMessage(SCOPE_1, 'sess-open')

    leaveDraftMessagePage(SCOPE_1)

    expect(getDraftMessageByScopeKey(SCOPE_1)).toBeUndefined()
    expect(getDraftSessionBySessionId('sess-open')?.status).toBe('released')
    expect(discard).toHaveBeenCalledWith({
      sessionIds: ['sess-open'],
      reason: 'draft_cancel',
      draftSessionPhase: 'open',
    })
  })

  it('#7898 离开页面不打断 sending 会话', () => {
    const draftMessage = getDraftMessageByScopeKey(SCOPE_1)!
    const discard = vi.fn()
    setAbandonedEmptySessionDiscarder(discard)
    bindDraftSessionToMessage(SCOPE_1, 'sess-sending', { phase: 'sending' })

    leaveDraftMessagePage(SCOPE_1)

    expect(getDraftMessageByScopeKey(SCOPE_1)?.draftMessageId).toBe(draftMessage.draftMessageId)
    expect(getDraftSessionBySessionId('sess-sending')?.status).toBe('pending')
    expect(discard).not.toHaveBeenCalled()
  })

  it('登出重置只清用户状态，重新登录后应用端口仍可用', () => {
    const discard = vi.fn()
    setAbandonedEmptySessionDiscarder(discard)

    resetDraftMessageSessionState()
    beginDraftMessageSession(SCOPE_1)
    syncDraftModeIntent('plan', {
      draftScopeKey: SCOPE_1,
      isUiDraft: true,
      hiddenSessionId: 'sess-after-login',
    })
    cancelDraftMessageSessionByScopeKey(SCOPE_1)

    expect(mocks.setSessionAgentMode).toHaveBeenCalledWith('sess-after-login', 'plan')
    expect(discard).toHaveBeenCalledWith({
      sessionIds: ['sess-after-login'],
      reason: 'draft_cancel',
      draftSessionPhase: 'open',
    })
  })

  it('E. 无绑定 session 时 preflight 为 no-op（普通 active session）', async () => {
    const result = await commitDraftMessageConfigBeforeSend({
      sessionId: 'sess-active-normal',
      getSession: () => ({ id: 'sess-active-normal', agent_id: 'agent-1' }),
      updateSessionInCaches: vi.fn(),
      patchSessionAgent,
    })
    expect(result).toEqual({ ok: true, applied: false })
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it('B. Workspace A/B 两个 draft scope 并发不串 pending/token', () => {
    const epA = beginDraftMessageSession(SCOPE_A, { executionWorkspaceId: 'workspace-a' })
    const epB = beginDraftMessageSession(SCOPE_B, { executionWorkspaceId: 'workspace-b' })
    bindDraftSessionToMessage(SCOPE_A, 'local-pending-a', { draftMessageId: epA.draftMessageId })
    bindDraftSessionToMessage(SCOPE_B, 'local-pending-b', { draftMessageId: epB.draftMessageId })
    expect(getDraftSessionBySessionId('local-pending-a')?.draftScopeKey).toBe(SCOPE_A)
    expect(getDraftSessionBySessionId('local-pending-b')?.draftScopeKey).toBe(SCOPE_B)
    expect(bindDraftSessionToMessage(SCOPE_B, 'local-pending-a')).toBeNull()
  })

  it('C. Project draft 与个人 Workspace draft 并发不串（无需伪造 Project id）', () => {
    const personal = beginDraftMessageSession('conversation:draft:ws-personal', {
      executionWorkspaceId: 'ws-personal',
    })
    // Project host 不得填进 executionWorkspaceId；执行现场另有真实 Workspace id
    const projectDraft = beginDraftMessageSession('conversation:draft:project-host', {
      organizationId: 'org-1',
      projectId: 'project-host',
      executionWorkspaceId: 'ws-exec-b',
    })
    expect(personal.projectId).toBeUndefined()
    expect(projectDraft.projectId).toBe('project-host')
    expect(projectDraft.executionWorkspaceId).toBe('ws-exec-b')
    expect(projectDraft.executionWorkspaceId).not.toBe('project-host')
    bindDraftSessionToMessage(personal.draftScopeKey, 'local-pending-personal')
    bindDraftSessionToMessage(projectDraft.draftScopeKey, 'local-pending-project')
    expect(getDraftSessionBySessionId('local-pending-personal')?.draftScopeKey)
      .toBe(personal.draftScopeKey)
    expect(getDraftSessionBySessionId('local-pending-project')?.draftScopeKey)
      .toBe(projectDraft.draftScopeKey)
  })

  it('F. bind ownership 冲突 → 返回 null；reclaimFromOpenDraftMessage 可从 open foreign 回收', () => {
    const epA = beginDraftMessageSession(SCOPE_A)
    bindDraftSessionToMessage(SCOPE_A, 'local-pending-shared', { draftMessageId: epA.draftMessageId })
    beginDraftMessageSession(SCOPE_B)
    expect(bindDraftSessionToMessage(SCOPE_B, 'local-pending-shared')).toBeNull()
    expect(getDraftSessionBySessionId('local-pending-shared')?.draftScopeKey).toBe(SCOPE_A)

    const stolen = bindDraftSessionToMessage(SCOPE_B, 'local-pending-shared', {
      reclaimFromOpenDraftMessage: true,
      phase: 'sending',
    })
    expect(stolen?.draftScopeKey).toBe(SCOPE_B)
    expect(stolen?.phase).toBe('sending')
    expect(getDraftSessionBySessionId('local-pending-shared')?.draftScopeKey).toBe(SCOPE_B)
    expect(getDraftMessageById(epA.draftMessageId)).toBeDefined()
  })

  it('F2. reclaim 不得抢走 sending 中的 foreign episode', () => {
    const epA = beginDraftMessageSession(SCOPE_A)
    bindDraftSessionToMessage(SCOPE_A, 'sess-sending', {
      draftMessageId: epA.draftMessageId,
      phase: 'sending',
    })
    beginDraftMessageSession(SCOPE_B)
    expect(bindDraftSessionToMessage(SCOPE_B, 'sess-sending', {
      reclaimFromOpenDraftMessage: true,
    })).toBeNull()
    expect(getDraftSessionBySessionId('sess-sending')?.draftScopeKey).toBe(SCOPE_A)
  })

  it('G. resetAllDraftMessages 清全部；旧 in-flight 回包不写 cache', async () => {
    let resolveStale!: (value: { id: string; agent_id: string }) => void
    mocks.updateSession.mockImplementationOnce(
      () => new Promise((resolve) => { resolveStale = resolve }),
    )
    const updateSessionInCaches = vi.fn()
    bindDraftSessionToMessage(SCOPE_1, 'sess-hidden')
    const stale = syncDraftAgentIntent(
      'agent-a',
      {
        draftScopeKey: SCOPE_1,
        isUiDraft: true,
        hiddenSessionId: 'sess-hidden',
      },
      { updateSessionInCaches, patchSessionAgent },
    )
    await vi.waitFor(() => expect(mocks.updateSession).toHaveBeenCalledTimes(1))

    resetAllDraftMessages()
    expect(getDraftMessageByScopeKey(SCOPE_1)).toBeUndefined()
    expect(isDraftMessageActive('anything')).toBe(false)

    resolveStale({ id: 'sess-hidden', agent_id: 'agent-a' })
    await stale
    expect(updateSessionInCaches).not.toHaveBeenCalled()
  })

  it('expectedDraftMessageId mismatch → fail-closed', async () => {
    bindDraftSessionToMessage(SCOPE_1, 'sess-hidden')
    recordDraftAgentIntent(SCOPE_1, 'agent-2')
    const result = await commitDraftMessageConfigBeforeSend({
      sessionId: 'sess-hidden',
      getSession: () => ({ id: 'sess-hidden', agent_id: 'agent-1' }),
      updateSessionInCaches: vi.fn(),
      patchSessionAgent,
      expectedDraftMessageId: 'ep-wrong',
    })
    expect(result).toEqual({ ok: false, reason: 'draft_message_mismatch' })
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it('B. 首发 PATCH 失败 fail-closed：不清 intent，可重试', async () => {
    recordDraftAgentIntent(SCOPE_1, 'agent-2')
    bindDraftSessionToMessage(SCOPE_1, 'sess-hidden')
    mocks.updateSession.mockRejectedValueOnce(new Error('bind failed'))
    const updateSessionInCaches = vi.fn()
    const result = await commitDraftMessageConfigBeforeSend({
      sessionId: 'sess-hidden',
      getSession: () => ({ id: 'sess-hidden', agent_id: 'agent-1' }),
      updateSessionInCaches,
      patchSessionAgent,
    })
    expect(result).toMatchObject({ ok: false, reason: 'agent_bind_failed' })
    expect(getDraftMessageByScopeKey(SCOPE_1)?.agentId).toBe('agent-2')

    mocks.updateSession.mockResolvedValueOnce({ id: 'sess-hidden', agent_id: 'agent-2' })
    const retry = await commitDraftMessageConfigBeforeSend({
      sessionId: 'sess-hidden',
      getSession: () => ({ id: 'sess-hidden', agent_id: 'agent-1' }),
      updateSessionInCaches,
      patchSessionAgent,
    })
    expect(retry).toMatchObject({ ok: true, agentId: 'agent-2' })
  })

  it('E. commit 等待期间被新 generation 取代 → cancelled', async () => {
    recordDraftAgentIntent(SCOPE_1, 'agent-2')
    bindDraftSessionToMessage(SCOPE_1, 'sess-hidden')
    let releaseWait!: () => void
    mocks.updateSession.mockImplementation(
      () => new Promise((resolve) => {
        releaseWait = () => resolve({ id: 'sess-hidden', agent_id: 'agent-2' })
      }),
    )
    const hang = syncDraftAgentIntent(
      'agent-2',
      { draftScopeKey: SCOPE_1, isUiDraft: true, hiddenSessionId: 'sess-hidden' },
      { updateSessionInCaches: vi.fn(), patchSessionAgent },
    )
    await vi.waitFor(() => expect(mocks.updateSession).toHaveBeenCalled())

    const commitPromise = commitDraftMessageConfigBeforeSend({
      sessionId: 'sess-hidden',
      getSession: () => ({ id: 'sess-hidden', agent_id: 'agent-1' }),
      updateSessionInCaches: vi.fn(),
      patchSessionAgent,
    })
    beginDraftMessageSession(SCOPE_1)
    releaseWait()
    await hang
    const result = await commitPromise
    expect(result).toMatchObject({ ok: false, reason: 'cancelled' })
  })

  it('H. settle 后清理 sync tail；旧 generation in-flight 不写新 episode', async () => {
    let resolveStale!: (value: { id: string; agent_id: string }) => void
    mocks.updateSession.mockImplementationOnce(
      () => new Promise((resolve) => { resolveStale = resolve }),
    )
    const updateSessionInCaches = vi.fn()
    bindDraftSessionToMessage(SCOPE_1, 'sess-hidden')
    const stalePromise = syncDraftAgentIntent(
      'agent-a',
      { draftScopeKey: SCOPE_1, isUiDraft: true, hiddenSessionId: 'sess-hidden' },
      { updateSessionInCaches, patchSessionAgent },
    )
    await vi.waitFor(() => expect(mocks.updateSession).toHaveBeenCalledTimes(1))

    const oldDraftMessageId = getDraftMessageByScopeKey(SCOPE_1)!.draftMessageId
    beginDraftMessageSession(SCOPE_1)
    bindDraftSessionToMessage(SCOPE_1, 'sess-new')
    recordDraftAgentIntent(SCOPE_1, 'agent-b')
    expect(getDraftMessageByScopeKey(SCOPE_1)?.draftMessageId).not.toBe(oldDraftMessageId)

    resolveStale({ id: 'sess-hidden', agent_id: 'agent-a' })
    await stalePromise
    expect(updateSessionInCaches).not.toHaveBeenCalledWith(
      'sess-hidden',
      expect.objectContaining({ agent_id: 'agent-a' }),
    )

    await waitForDraftAgentSync(SCOPE_1)
    await Promise.resolve()
    await Promise.resolve()
    expect(__getAgentSyncTailSizeForTests()).toBe(0)
  })
})
