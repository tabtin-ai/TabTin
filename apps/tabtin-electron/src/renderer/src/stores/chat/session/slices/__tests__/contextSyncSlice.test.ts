import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAppContextCache, createContextSyncActions } from '../contextSyncSlice'
import { buildContextSyncFingerprint } from '../../../execution/contextSyncFingerprint'
import { useSessionAccessStore } from '../../sessionAccessStore'

// 收口后 contextSyncSlice 经 agentService 出站；mock 门面直接透传到
// window.tabtin.agentEngine.updateContext，保持本单测隔离（不加载 hub 的 chatApi
// 重依赖链），同时验证 slice 仍推送 app context。
vi.mock('@/services/agentService', () => ({
  getSessionController: (sessionId: string) => ({
    pushContext: (appContext: unknown) =>
      (globalThis as { window?: { tabtin?: { agentEngine?: { updateContext?: (...a: unknown[]) => { catch: (cb: () => void) => void } } } } })
        .window?.tabtin?.agentEngine?.updateContext?.(sessionId, appContext)?.catch(() => {}),
  }),
}))

const mockContextUpdate = vi.fn()
const mockUpdateContext = vi.fn()

vi.mock('@/utils/logger', () => ({
  logger: { log: vi.fn() },
}))

vi.mock('@/utils/deviceTimeZone', () => ({
  resolveDeviceTimeZone: () => 'Asia/Shanghai',
}))

vi.mock('../../../slices/runtime/chatTelemetry', () => ({
  trackChatTelemetry: vi.fn(),
}))

vi.mock('../../../slices/runtime/sendTimingTrace', () => ({
  getActiveSendTimingTrace: () => null,
  buildSendTimingPayload: () => ({}),
}))

describe('contextSyncSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearAppContextCache('sess-1')
    clearAppContextCache('task-run-session')
    clearAppContextCache('project-orchestration-session')
    useSessionAccessStore.setState({ bySessionId: {} })
    mockContextUpdate.mockResolvedValue(undefined)
    Object.defineProperty(window, 'tabtin', {
      value: {
        agentEngine: {
          updateContext: mockUpdateContext.mockResolvedValue(undefined),
        },
      },
      configurable: true,
    })
  })

  it('fingerprint 相同时 skip HTTP', async () => {
    const payload = {
      current_space_id: 'space-1',
      current_project_id: null,
      workspace_mode: null,
      current_app_type: null,
      userTimeZone: 'Asia/Shanghai',
      open_tabs: [],
    }
    const fingerprint = buildContextSyncFingerprint('sess-1', payload)
    const { syncContext } = createContextSyncActions(
      () => ({
        currentSessionId: 'sess-1',
        lastContextSyncFingerprintBySessionId: { 'sess-1': fingerprint },
      }),
      vi.fn(),
      { getChatClient: () => ({ context: { update: mockContextUpdate } }) },
    )

    await syncContext('space-1', null, null, [], { force: false })

    expect(mockContextUpdate).not.toHaveBeenCalled()
    expect(mockUpdateContext).not.toHaveBeenCalled()
  })

  it('deferHttpPersist 时 IPC 先行且不阻塞 HTTP', async () => {
    let resolveHttp!: () => void
    const httpGate = new Promise<void>((resolve) => {
      resolveHttp = resolve
    })
    mockContextUpdate.mockReturnValue(httpGate)

    const { syncContext } = createContextSyncActions(
      () => ({
        currentSessionId: 'sess-1',
        lastContextSyncFingerprintBySessionId: {},
      }),
      vi.fn(),
      { getChatClient: () => ({ context: { update: mockContextUpdate } }) },
    )

    const pending = syncContext('space-1', 'tabdoc', null, [], {
      force: false,
      deferHttpPersist: true,
    })

    await Promise.resolve()
    expect(mockUpdateContext).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      spaceId: 'space-1',
      appType: 'tabdoc',
    }))
    expect(mockContextUpdate).toHaveBeenCalled()
    resolveHttp()
    await pending
  })

  it('chat focus 覆盖视觉 Focus，不再把 project_task 伪装成当前看见的 App', async () => {
    const { syncContext } = createContextSyncActions(
      () => ({
        currentSessionId: 'task-run-session',
        lastContextSyncFingerprintBySessionId: {},
      }),
      vi.fn(),
      { getChatClient: () => ({ context: { update: mockContextUpdate } }) },
    )

    await syncContext('project-1', 'project_task', {
      project_id: 'project-1', task_id: 'task-1',
    }, [{ type: 'tabdoc', id: 'doc-1', title: '旧文档' }], { force: true })
    await syncContext('project-1', 'chat', null, [
      { type: 'tabdoc', id: 'doc-1', title: '旧文档' },
    ], {
      force: true,
      tabScopeKey: 'conversation:task-run-session',
    })

    expect(mockUpdateContext).toHaveBeenLastCalledWith(
      'task-run-session',
      expect.objectContaining({
        appType: 'chat',
        appMeta: null,
        openTabs: [],
        workspaceMode: 'conversation',
      }),
    )
    expect(mockContextUpdate).toHaveBeenLastCalledWith(
      'task-run-session',
      expect.objectContaining({
        current_app_type: 'chat',
        open_tabs: [],
        workspace_mode: 'conversation',
      }),
    )
  })

  it('程序化入口可把上下文定向同步到非当前会话', async () => {
    const { syncContext } = createContextSyncActions(
      () => ({
        currentSessionId: 'personal-session',
        lastContextSyncFingerprintBySessionId: {},
      }),
      vi.fn(),
      { getChatClient: () => ({ context: { update: mockContextUpdate } }) },
    )

    await syncContext('project-1', 'project_tasks', { project_id: 'project-1' }, [], {
      force: true,
      targetSessionId: 'project-orchestration-session',
    })

    expect(mockContextUpdate).toHaveBeenCalledWith(
      'project-orchestration-session',
      expect.objectContaining({ project_id: 'project-1' }),
    )
    expect(mockUpdateContext).toHaveBeenCalledWith(
      'project-orchestration-session',
      expect.objectContaining({
        appType: 'project_tasks',
        appMeta: { project_id: 'project-1' },
      }),
    )
  })

  it('共享任务 grantee 只同步 runtime context，不写 owner-only HTTP context', async () => {
    useSessionAccessStore.getState().setSharedAccess({
      sessionId: 'shared-session',
      shareId: 'share-1',
      role: 'grantee',
    })
    const setState = vi.fn()
    const { syncContext } = createContextSyncActions(
      () => ({
        currentSessionId: 'shared-session',
        lastContextSyncFingerprintBySessionId: {},
      }),
      setState,
      { getChatClient: () => ({ context: { update: mockContextUpdate } }) },
    )

    await syncContext('space-1', 'chat', null, [], { force: true })

    expect(mockUpdateContext).toHaveBeenCalledWith(
      'shared-session',
      expect.objectContaining({
        appType: 'chat',
        openTabs: [],
      }),
    )
    expect(mockContextUpdate).not.toHaveBeenCalled()
    expect(setState).toHaveBeenCalled()
  })

  it('共享 owner 仍可持久化自己的 context', async () => {
    useSessionAccessStore.getState().setSharedAccess({
      sessionId: 'owner-session',
      shareId: 'share-1',
      role: 'owner',
    })
    const { syncContext } = createContextSyncActions(
      () => ({
        currentSessionId: 'owner-session',
        lastContextSyncFingerprintBySessionId: {},
      }),
      vi.fn(),
      { getChatClient: () => ({ context: { update: mockContextUpdate } }) },
    )

    await syncContext('space-1', 'chat', null, [], { force: true })

    expect(mockContextUpdate).toHaveBeenCalledWith(
      'owner-session',
      expect.objectContaining({
        current_app_type: 'chat',
        open_tabs: [],
      }),
    )
  })
})
