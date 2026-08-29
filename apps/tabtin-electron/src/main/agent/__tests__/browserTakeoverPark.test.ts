import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getAppPath: () => '/tmp',
    on: () => undefined,
    once: () => undefined,
    whenReady: () => Promise.resolve(),
  },
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
    on: () => undefined,
    off: () => undefined,
    removeAllListeners: () => undefined,
  },
  BrowserWindow: class FakeBrowserWindow {
    static getAllWindows() { return [] }
    static fromWebContents() { return null }
    webContents = { send: () => undefined }
  },
  webContents: {
    fromId: () => null,
    getAllWebContents: () => [],
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  powerMonitor: {
    on: () => undefined,
    off: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  },
  net: { isOnline: () => true },
  session: {
    defaultSession: {
      webRequest: { onBeforeRequest: () => undefined },
    },
  },
  shell: { openExternal: () => Promise.resolve() },
}))

vi.mock('electron-log', () => {
  const noop = () => {}
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    log: noop,
    verbose: noop,
    silly: noop,
  }
  return {
    default: {
      transports: { file: { level: 'info' }, console: { level: 'info' } },
      create: () => logger,
      scope: () => logger,
      ...logger,
    },
  }
})

vi.mock('../../auth', () => ({
  TokenManager: {
    getAccessToken: vi.fn().mockResolvedValue('test-token'),
    getCachedUserInfo: vi.fn(() => null),
    onAuthChanged: vi.fn(),
  },
}))

vi.mock('../../config/api', () => ({
  API_BASE_URL: 'https://api.test.local',
  WS_BASE_URL: 'wss://api.test.local',
}))

vi.mock('../../window-manager', () => ({
  getMainWindow: () => null,
}))

vi.mock('../../ws/ElectronWsGateway', () => ({
  electronWsGateway: {
    getDeviceId: () => 'device-test',
    on: () => () => undefined,
    onReconnect: () => () => undefined,
    requestWithLastAuth: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

vi.mock('../../cli/cli-server', () => ({
  getCLIOrganizationRoot: () => null,
  getCLISpaceId: () => undefined,
  getCLIOrganizationId: () => undefined,
  syncCLISpaceContextFromQueryRequest: vi.fn(),
  setCLIWorkspaceScopeKey: vi.fn(),
  getCLIWorkspaceScopeKey: () => undefined,
  setCLIOrganizationRootIfMissing: vi.fn(),
  onCLISpaceContextChanged: () => () => undefined,
  CLIWorkspaceScopeTurnLeaseManager: class {
    start(): void {}
    settle(): void {}
  },
}))

vi.mock('@tabtin/cli-server-core/surfaces/agent-security', () => ({
  createAgentSecuritySurfaces: () => [],
}))
vi.mock('@tabtin/cli-server-core/surfaces/skill-list', () => ({
  createSkillListSurface: () => ({}),
}))
vi.mock('@tabtin/cli-server-core/surfaces/skill-materialize-app', () => ({
  createSkillMaterializeAppSurface: () => ({}),
}))
vi.mock('@tabtin/app-shell/agent-config-v2', () => ({
  normalizeExecutionLimitsForCostCap: (value: unknown) => value,
}))

const { ElectronAgentHost } = await import('../ElectronAgentHost')
const { SessionPauseController } = await import('@tabtin/agent-host/delivery')
const {
  consumeHandBackNotice,
  getBrowserTabControlSnapshot,
  handBackToAgent,
  isUserControllingSession,
  lock,
  resetBrowserTabInputLockForTests,
  takeOverByUser,
} = await import('../../browser-tab-lock/browserTabInputLock')

type MinimalSession = {
  sessionId: string
  businessThreadId: string
  pauseController: InstanceType<typeof SessionPauseController>
  abortController: AbortController
}

type HostHarness = {
  browserControlOwnershipBySessionKey: Map<string, unknown>
  promoteCancelEchoGuardUntil: Map<string, number>
  pendingPauseCandidateIds: Set<string>
  abortRequestedSessionIds: Set<string>
  sharedHost: {
    sessions: Map<string, MinimalSession>
    abort: ReturnType<typeof vi.fn>
    abortConversationRuns: ReturnType<typeof vi.fn>
    publish: ReturnType<typeof vi.fn>
    interruptAndPromote: ReturnType<typeof vi.fn>
    cancelSessionDelivery: ReturnType<typeof vi.fn>
  }
  agentWorktreeTransitions: Map<string, unknown>
  hostStateSync: { stop: ReturnType<typeof vi.fn> }
  hostTrackerScheduler: { stop: ReturnType<typeof vi.fn> }
  hostTrackerReconnectUnsubscribe: null
  approvalGate: null
  runHostLeaseCoordinator: { stop: ReturnType<typeof vi.fn> }
  forwardLeaseAbortKeys: Set<string>
  runHostLeaseReconnectUnsubscribe: null
  catalogRefreshTimer: null
  notificationQueueUnsubscribe: null
  mcpToolCacheUnsubscribe: null
  _modeSwitchHandler: null
  parkBrowserControl(sessionIds: readonly string[]): string[]
  releaseBrowserControl(sessionIds: readonly string[]): string[]
  areBrowserControlSessionsParked(sessionIds: readonly string[]): boolean
  getBrowserControlOwnedSessionIds(sessionIds: readonly string[]): string[]
  getBrowserControlStatus(sessionIds: readonly string[]): {
    ownedSessionIds: string[]
    parkedSessionIds: string[]
    unresolvedSessionIds: string[]
  }
  clearBrowserControlForStoppedSession(sessionId: string): void
  clearAllBrowserControlForHostStop(): void
  abortSessionForHostStop(sessionId: string): void
  armPromoteCancelEchoGuard(...sessionIds: string[]): void
  abortSessionByKey(sessionId: string): void
  handleAbort(sessionId?: string): { success: boolean }
  handleResumeFromEnvelope(envelope: Record<string, unknown>): { success: boolean }
  stop(): Promise<void>
  handlePromoteRun(payload: { sessionId: string; runId: string }): Promise<{
    success: boolean
    promoted: boolean
  }>
  emitRunSyncEvent(payload: {
    session_id: string
    run_id: string | null
    status: 'idle' | 'running' | 'queued'
    seq: number
    queued_run_ids: string[]
  }): void
}

function createHarness(session: MinimalSession): HostHarness {
  const host = Object.create(ElectronAgentHost.prototype) as HostHarness
  host.browserControlOwnershipBySessionKey = new Map()
  host.promoteCancelEchoGuardUntil = new Map()
  host.pendingPauseCandidateIds = new Set()
  host.abortRequestedSessionIds = new Set()
  host.sharedHost = {
    sessions: new Map([[session.sessionId, session]]),
    abort: vi.fn(),
    abortConversationRuns: vi.fn(),
    publish: vi.fn(() => 1),
    interruptAndPromote: vi.fn(() => ({
      promoted: true,
      abortedActive: true,
      abortedRunId: 'active-run',
      queuedRunIds: [],
    })),
    cancelSessionDelivery: vi.fn().mockResolvedValue(undefined),
  }
  host.agentWorktreeTransitions = new Map()
  host.hostStateSync = { stop: vi.fn() }
  host.hostTrackerScheduler = { stop: vi.fn() }
  host.hostTrackerReconnectUnsubscribe = null
  host.approvalGate = null
  host.runHostLeaseCoordinator = { stop: vi.fn() }
  host.forwardLeaseAbortKeys = new Set()
  host.runHostLeaseReconnectUnsubscribe = null
  host.catalogRefreshTimer = null
  host.notificationQueueUnsubscribe = null
  host.mcpToolCacheUnsubscribe = null
  host._modeSwitchHandler = null
  return host
}

function createSession(): MinimalSession {
  return {
    sessionId: 'task-1',
    businessThreadId: 'chat-session-session-1',
    pauseController: new SessionPauseController(),
    abortController: new AbortController(),
  }
}

describe('ElectronAgentHost browser takeover park', () => {
  beforeEach(() => {
    resetBrowserTabInputLockForTests()
  })

  it('只对真实解析到的 session acquire/release 一次，并保留其它 HITL 引用', () => {
    const session = createSession()
    const host = createHarness(session)
    session.pauseController.acquireHitlPark()

    expect(host.parkBrowserControl(['session-1', 'missing', 'session-1'])).toEqual(['session-1'])
    expect(host.areBrowserControlSessionsParked(['session-1'])).toBe(true)
    expect(host.parkBrowserControl(['session-1'])).toEqual([])

    expect(host.releaseBrowserControl(['missing', 'session-1', 'session-1'])).toEqual(['session-1'])
    expect(host.areBrowserControlSessionsParked(['session-1'])).toBe(false)
    expect(session.pauseController.isHitlParked).toBe(true)

    session.pauseController.releaseHitlPark()
    expect(session.pauseController.isHitlParked).toBe(false)
  })

  it('session 终态清理 host park、用户控制态、notice 与锁，且重复调用幂等', () => {
    const session = createSession()
    const host = createHarness(session)
    lock('view-1', 'session-1')
    expect(takeOverByUser('view-1')).toEqual(['session-1'])
    host.parkBrowserControl(['session-1'])
    expect(handBackToAgent('view-1')).toEqual({
      affectedSessionIds: ['session-1'],
      releaseSessionIds: ['session-1'],
    })

    host.clearBrowserControlForStoppedSession('task-1')
    host.clearBrowserControlForStoppedSession('session-1')

    expect(session.pauseController.isHitlParked).toBe(false)
    expect(isUserControllingSession('session-1')).toBe(false)
    expect(consumeHandBackNotice('session-1')).toBe(false)
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: [],
      userControlledViewIds: [],
      sessionIdsByViewId: {},
    })
  })

  it('abort 主路径真实调用终态清理', () => {
    const session = createSession()
    const host = createHarness(session)
    lock('view-1', 'session-1')
    takeOverByUser('view-1')
    host.parkBrowserControl(['session-1'])

    host.abortSessionByKey('task-1')

    expect(session.pauseController.isHitlParked).toBe(false)
    expect(isUserControllingSession('session-1')).toBe(false)
  })

  it('全量 stop 使用的 handleAbort 主路径逐 session 清理', () => {
    const session = createSession()
    const host = createHarness(session)
    lock('view-1', 'session-1')
    takeOverByUser('view-1')
    host.parkBrowserControl(['session-1'])

    expect(host.handleAbort()).toEqual({ success: true })

    expect(session.pauseController.isHitlParked).toBe(false)
    expect(isUserControllingSession('session-1')).toBe(false)
  })

  it('run idle 主路径清理且不消费或遗留 handback notice', () => {
    const session = createSession()
    const host = createHarness(session)
    lock('view-1', 'session-1')
    takeOverByUser('view-1')
    host.parkBrowserControl(['session-1'])
    handBackToAgent('view-1')

    host.emitRunSyncEvent({
      session_id: 'session-1',
      run_id: null,
      status: 'idle',
      seq: 1,
      queued_run_ids: [],
    })

    expect(session.pauseController.isHitlParked).toBe(false)
    expect(consumeHandBackNotice('session-1')).toBe(false)
  })

  it('session 从 Map 删除后仍按 ownership 记录释放真实 controller', () => {
    const session = createSession()
    const host = createHarness(session)
    host.parkBrowserControl(['session-1'])
    host.sharedHost.sessions.delete('task-1')

    expect(host.releaseBrowserControl(['session-1'])).toEqual(['session-1'])
    expect(session.pauseController.isHitlParked).toBe(false)
    expect(host.getBrowserControlOwnedSessionIds(['session-1'])).toEqual([])
  })

  it('Host shutdown 会释放已脱离 sessions Map 的全部 ownership', () => {
    const session = createSession()
    const host = createHarness(session)
    host.parkBrowserControl(['session-1'])
    host.sharedHost.sessions.delete('task-1')

    host.clearAllBrowserControlForHostStop()

    expect(session.pauseController.isHitlParked).toBe(false)
    expect(host.getBrowserControlOwnedSessionIds(['session-1'])).toEqual([])
  })

  it('Host shutdown 也清理无 live session、无 ownership 的 registry 残留', () => {
    const session = createSession()
    const host = createHarness(session)
    lock('notice-view', 'session-1')
    takeOverByUser('notice-view')
    handBackToAgent('notice-view')
    lock('controlled-view', 'session-1')
    takeOverByUser('controlled-view')
    lock('locked-view', 'session-1')
    host.sharedHost.sessions.delete('task-1')

    host.clearAllBrowserControlForHostStop()

    expect(isUserControllingSession('session-1')).toBe(false)
    expect(consumeHandBackNotice('session-1')).toBe(false)
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: [],
      userControlledViewIds: [],
      sessionIdsByViewId: {},
    })
  })

  it('同 key session 重建后状态查询拒绝旧 controller，重复 park 会迁移 ownership', () => {
    const oldSession = createSession()
    const host = createHarness(oldSession)
    host.parkBrowserControl(['session-1'])
    const newSession = {
      ...createSession(),
      pauseController: new SessionPauseController(),
      abortController: new AbortController(),
    }
    host.sharedHost.sessions.set('task-1', newSession)

    expect(host.getBrowserControlStatus(['session-1'])).toEqual({
      ownedSessionIds: ['session-1'],
      parkedSessionIds: [],
      unresolvedSessionIds: [],
    })
    expect(host.areBrowserControlSessionsParked(['session-1'])).toBe(false)
    expect(host.parkBrowserControl(['session-1'])).toEqual(['session-1'])
    expect(oldSession.pauseController.isHitlParked).toBe(false)
    expect(newSession.pauseController.isHitlParked).toBe(true)
    expect(host.areBrowserControlSessionsParked(['session-1'])).toBe(true)
  })

  it('remote resume 会把旧 controller ownership 迁移到重建 session', () => {
    const oldSession = createSession()
    const host = createHarness(oldSession)
    host.parkBrowserControl(['session-1'])
    const newSession = {
      ...createSession(),
      pauseController: new SessionPauseController(),
      abortController: new AbortController(),
    }
    host.sharedHost.sessions.set('task-1', newSession)

    expect(host.handleResumeFromEnvelope({
      payload: { session_id: 'session-1' },
    })).toEqual({ success: true })

    expect(oldSession.pauseController.isHitlParked).toBe(false)
    expect(newSession.pauseController.isHitlParked).toBe(true)
    expect(host.areBrowserControlSessionsParked(['session-1'])).toBe(true)
  })

  it('无 live session 且无 ownership 明确视为已 unparked，而非 unresolved', () => {
    const session = createSession()
    const host = createHarness(session)
    host.sharedHost.sessions.delete('task-1')

    expect(host.getBrowserControlStatus(['session-1'])).toEqual({
      ownedSessionIds: [],
      parkedSessionIds: [],
      unresolvedSessionIds: [],
    })
  })

  it('同一 alias 命中多个真实 key 时拒绝 park 且不谎报成功', () => {
    const first = createSession()
    const second = {
      ...createSession(),
      sessionId: 'task-2',
      pauseController: new SessionPauseController(),
      abortController: new AbortController(),
    }
    const host = createHarness(first)
    host.sharedHost.sessions.set(second.sessionId, second)

    expect(host.parkBrowserControl(['session-1'])).toEqual([])
    expect(host.areBrowserControlSessionsParked(['session-1'])).toBe(false)
    expect(first.pauseController.isHitlParked).toBe(false)
    expect(second.pauseController.isHitlParked).toBe(false)
  })

  it('ownership 查询同时核对 controller 实态，重复 park 可修复漂移', () => {
    const session = createSession()
    const host = createHarness(session)
    host.parkBrowserControl(['session-1'])
    session.pauseController.releaseHitlPark()

    expect(host.areBrowserControlSessionsParked(['session-1'])).toBe(false)
    expect(host.parkBrowserControl(['session-1'])).toEqual([])
    expect(host.areBrowserControlSessionsParked(['session-1'])).toBe(true)
  })

  it('remote resume 即使通用 resume 清掉 park 也会重建 browser ownership', () => {
    const session = createSession()
    const host = createHarness(session)
    host.parkBrowserControl(['session-1'])
    vi.spyOn(session.pauseController, 'resume').mockImplementation(() => {
      session.pauseController.releaseHitlPark()
      return true
    })

    expect(host.handleResumeFromEnvelope({
      payload: { session_id: 'session-1' },
    })).toEqual({ success: true })

    expect(host.areBrowserControlSessionsParked(['session-1'])).toBe(true)
    expect(session.pauseController.isHitlParked).toBe(true)
  })

  it('interrupt-and-promote 通用 resume 后保持 browser park', async () => {
    const session = createSession()
    const host = createHarness(session)
    host.parkBrowserControl(['session-1'])
    vi.spyOn(session.pauseController, 'resume').mockImplementation(() => {
      session.pauseController.releaseHitlPark()
      return true
    })

    await expect(host.handlePromoteRun({
      sessionId: 'session-1',
      runId: 'queued-run',
    })).resolves.toMatchObject({ success: true, promoted: true })

    expect(host.areBrowserControlSessionsParked(['session-1'])).toBe(true)
    expect(session.pauseController.isHitlParked).toBe(true)
  })

  it('stop 的带 sid 路径命中 promote echo guard 仍无条件双清', () => {
    const session = createSession()
    const host = createHarness(session)
    lock('notice-view', 'session-1')
    takeOverByUser('notice-view')
    handBackToAgent('notice-view')
    lock('controlled-view', 'session-1')
    takeOverByUser('controlled-view')
    lock('locked-view', 'session-1')
    host.parkBrowserControl(['session-1'])
    host.armPromoteCancelEchoGuard('session-1', 'task-1')

    host.abortSessionForHostStop('task-1')

    expect(session.pauseController.isHitlParked).toBe(false)
    expect(isUserControllingSession('session-1')).toBe(false)
    expect(consumeHandBackNotice('session-1')).toBe(false)
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: [],
      userControlledViewIds: [],
      sessionIdsByViewId: {},
    })
  })

  it('真实 stop 中 cancellation reject 仍全局清理且保留原始异常', async () => {
    const first = createSession()
    const second = {
      ...createSession(),
      sessionId: 'task-2',
      businessThreadId: 'chat-session-session-2',
      pauseController: new SessionPauseController(),
      abortController: new AbortController(),
    }
    const host = createHarness(first)
    host.sharedHost.sessions.set(second.sessionId, second)
    lock('controlled-view', 'session-2')
    takeOverByUser('controlled-view')
    host.parkBrowserControl(['session-2'])
    lock('detached-view', 'detached-session')
    takeOverByUser('detached-view')
    const cancellationError = new Error('cancel delivery failed')
    host.sharedHost.cancelSessionDelivery.mockRejectedValueOnce(cancellationError)

    await expect(host.stop()).rejects.toBe(cancellationError)

    expect(second.pauseController.isHitlParked).toBe(false)
    expect(isUserControllingSession('session-2')).toBe(false)
    expect(isUserControllingSession('detached-session')).toBe(false)
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: [],
      userControlledViewIds: [],
      sessionIdsByViewId: {},
    })
  })
})
