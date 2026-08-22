import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getCLIServerInfoMock,
  evaluateLocalTerminalPolicyMock,
  getInteractiveTerminalPolicySupportErrorMock,
  evaluateTerminalPolicyDegradationMock,
  executeDegradedMock,
  requestApprovalMock,
} = vi.hoisted(() => ({
  getCLIServerInfoMock: vi.fn(() => null),
  evaluateLocalTerminalPolicyMock: vi.fn(() => ({ blocked: false })),
  getInteractiveTerminalPolicySupportErrorMock: vi.fn(() => 'sandbox mode unsupported'),
  evaluateTerminalPolicyDegradationMock: vi.fn(() => ({ canDegrade: true })),
  executeDegradedMock: vi.fn(),
  requestApprovalMock: vi.fn(),
}))

vi.mock('../../cli/cli-server', () => ({
  getCLIServerInfo: getCLIServerInfoMock,
}))

vi.mock('../../services/ApprovalManager', () => ({
  requestApproval: requestApprovalMock,
}))

vi.mock('@tabtin/terminal-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/terminal-core')>()
  return {
    ...actual,
    evaluateLocalTerminalPolicy: evaluateLocalTerminalPolicyMock,
    getInteractiveTerminalPolicySupportError: getInteractiveTerminalPolicySupportErrorMock,
    evaluateTerminalPolicyDegradation: evaluateTerminalPolicyDegradationMock,
    executeDegraded: executeDegradedMock,
  }
})

import { PtyManager } from '../PtyManager'
import type { PtyHostClient, PtyHostSession } from '../PtyHost'
import { getHumanInteractionContext } from '@tabtin/agent-runtime'

class MockHostSession implements PtyHostSession {
  pid = 9527

  private spawnedHandler?: (event: { pid: number }) => void
  private dataHandler?: (data: string) => void
  private exitHandler?: (event: { exitCode: number | null; signal?: number }) => void

  write = vi.fn()
  pauseOutput = vi.fn()
  resumeOutput = vi.fn()
  resize = vi.fn()
  kill = vi.fn()

  onSpawned = vi.fn((handler: (event: { pid: number }) => void) => {
    this.spawnedHandler = handler
    return { dispose: vi.fn() }
  })

  onData = vi.fn((handler: (data: string) => void) => {
    this.dataHandler = handler
    return { dispose: vi.fn() }
  })

  onExit = vi.fn((handler: (event: { exitCode: number | null; signal?: number }) => void) => {
    this.exitHandler = handler
    return { dispose: vi.fn() }
  })
}

class MockPtyHostClient implements PtyHostClient {
  private readonly sessions: MockHostSession[] = []

  spawn = vi.fn(() => {
    const session = new MockHostSession()
    this.sessions.push(session)
    return session
  })

  getLastSession(): MockHostSession {
    const session = this.sessions.at(-1)
    if (!session) {
      throw new Error('No host session created')
    }
    return session
  }
}

class MockProcessTerminator {
  terminateTree = vi.fn()
}

describe('PtyManager degraded approval fallback', () => {
  let hostClient: MockPtyHostClient
  let processTerminator: MockProcessTerminator
  let manager: PtyManager

  beforeEach(() => {
    vi.clearAllMocks()
    getCLIServerInfoMock.mockReturnValue(null)
    evaluateLocalTerminalPolicyMock.mockReturnValue({ blocked: false })
    getInteractiveTerminalPolicySupportErrorMock.mockReturnValue('sandbox mode unsupported')
    evaluateTerminalPolicyDegradationMock.mockReturnValue({ canDegrade: true })
    executeDegradedMock.mockResolvedValue({
      interactiveBlocked: true,
      interactiveReason: 'command requires a TTY',
      exitCode: 126,
      stdout: '',
      stderr: '',
      cwd: '/tmp',
      timedOut: false,
      durationMs: 1,
    })
    requestApprovalMock.mockResolvedValue({ approved: true })

    hostClient = new MockPtyHostClient()
    processTerminator = new MockProcessTerminator()
    manager = new PtyManager(hostClient, processTerminator as any)
  })

  afterEach(() => {
    manager.cleanup()
  })

  it('审批通过后走正常 PTY 执行副作用链路', async () => {
    let approvalThreadId: string | undefined
    requestApprovalMock.mockImplementation(async () => {
      approvalThreadId = getHumanInteractionContext()?.threadId
      return { approved: true }
    })
    expect(manager.spawn('s-degraded', { cwd: '/tmp' })).toBe(true)
    const hostSession = hostClient.getLastSession()

    manager.setRendererDataSubscription('s-degraded', false)
    expect(hostSession.pauseOutput).toHaveBeenCalledTimes(1)

    const paneStatusEvents: Array<{ sessionId: string; status: string }> = []
    manager.on('pane-status', (event) =>
      paneStatusEvents.push({ sessionId: event.sessionId, status: event.status }),
    )

    const sessionStore = (manager as any).sessionStore
    const executeSpy = vi
      .spyOn((manager as any).commandRunner, 'execute')
      .mockImplementation(async (sessionId: string) => {
        sessionStore.setPendingCommand(sessionId, {
          nonce: 'nonce',
          startMarker: '__start__',
          endMarkerPrefix: '__end_',
          startedAt: Date.now(),
          bufferStartCursor: 0,
          resolve: vi.fn(),
          timer: null,
          sessionId,
        })
        await Promise.resolve()
        sessionStore.deletePendingCommand(sessionId)
        return {
          output: 'ok',
          exitCode: 0,
          cwd: '/tmp',
          backgrounded: false,
          timedOut: false,
          durationMs: 12,
          sessionId,
        }
      })

    const result = await manager.executeCommand('s-degraded', 'read -p "name" foo', {
      blockUntilMs: 5_000,
      policy: { mode: 'sandbox' } as any,
      context: { env: { FOO: 'bar' }, spaceId: 'space-1', threadId: 'chat-session-11111111-1111-1111-1111-111111111111' } as any,
      autoRespond: [{ pattern: 'Continue?', response: 'yes\n' }],
      killOnTimeout: false,
    })

    expect(result.exitCode).toBe(0)
    expect(executeDegradedMock).toHaveBeenCalledOnce()
    expect(requestApprovalMock).toHaveBeenCalledOnce()
    expect(requestApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        isStrict: true,
      }),
    )
    expect(approvalThreadId).toBe('chat-session-11111111-1111-1111-1111-111111111111')
    expect(executeSpy).toHaveBeenCalledWith(
      's-degraded',
      'read -p "name" foo',
      expect.objectContaining({
        blockUntilMs: 5_000,
        workingDirectory: '/tmp',
        autoRespond: [{ pattern: 'Continue?', response: 'yes\n' }],
        killOnTimeout: false,
        env: expect.objectContaining({
          FOO: 'bar',
          TABTIN_SPACE_ID: 'space-1',
          TABTIN_AGENT_SPACE_ID: 'space-1',
        }),
      }),
    )
    expect(hostSession.resumeOutput).toHaveBeenCalled()
    expect(paneStatusEvents).toEqual(
      expect.arrayContaining([
        { sessionId: 's-degraded', status: 'running' },
        { sessionId: 's-degraded', status: 'idle' },
      ]),
    )
  })
})
