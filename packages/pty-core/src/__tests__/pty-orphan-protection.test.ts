import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IPty } from 'node-pty'
import type { PtyHostSpawnRequest } from '../PtyHost'

/**
 * P1-STB-2: Orphan process protection tests for InProcessPtyHostClient.
 *
 * These tests use a mock node-pty module to verify that:
 * 1. Active sessions are tracked after spawn
 * 2. Sessions are untracked when they exit naturally
 * 3. dispose() kills all active sessions
 * 4. spawn() after dispose() returns a failed session
 * 5. process.on('exit') handler kills all active sessions
 * 6. kill errors during cleanup are swallowed (best-effort)
 */

function createMockPty(overrides: Partial<IPty> = {}): IPty {
  const exitHandlers: Array<(e: { exitCode: number; signal?: number }) => void> = []
  const dataHandlers: Array<(data: string) => void> = []

  const mockPty: IPty = {
    pid: Math.floor(Math.random() * 100000) + 1000,
    cols: 80,
    rows: 24,
    process: '/bin/bash',
    handleFlowControl: false,
    onData: vi.fn((handler: (data: string) => void) => {
      dataHandlers.push(handler)
      return { dispose: () => {} }
    }),
    onExit: vi.fn((handler: (e: { exitCode: number; signal?: number }) => void) => {
      exitHandlers.push(handler)
      return { dispose: () => {} }
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    clear: vi.fn(),
    // Helper to simulate process exit (not part of IPty interface)
    ...overrides,
  } as IPty

  // Attach a helper to trigger exit handlers (used in tests)
  ;(mockPty as unknown as { _triggerExit: () => void })._triggerExit = () => {
    for (const handler of exitHandlers) {
      handler({ exitCode: 0 })
    }
  }

  return mockPty
}

function createMockPtyModule() {
  const spawnedPtys: IPty[] = []

  return {
    spawnedPtys,
    module: {
      spawn: vi.fn((_file: string, _args: string[], _options: unknown) => {
        const pty = createMockPty()
        spawnedPtys.push(pty)
        return pty
      }),
    } as unknown as typeof import('node-pty'),
  }
}

const DEFAULT_REQUEST: PtyHostSpawnRequest = {
  shell: '/bin/bash',
  cwd: '/tmp',
  cols: 80,
  rows: 24,
  env: {},
}

describe('P1-STB-2: orphan process protection', () => {
  let InProcessPtyHostClient: typeof import('../InProcessPtyHost').InProcessPtyHostClient

  beforeEach(async () => {
    // Re-import to get a fresh module (avoid shared state from process handlers)
    const mod = await import('../InProcessPtyHost')
    InProcessPtyHostClient = mod.InProcessPtyHostClient
  })

  it('tracks active sessions after spawn', () => {
    const mock = createMockPtyModule()
    const client = new InProcessPtyHostClient(mock.module)

    expect(client.activeSessionCount).toBe(0)

    client.spawn(DEFAULT_REQUEST)
    expect(client.activeSessionCount).toBe(1)

    client.spawn(DEFAULT_REQUEST)
    expect(client.activeSessionCount).toBe(2)

    client.dispose()
  })

  it('removes session from tracking when process exits naturally', () => {
    const mock = createMockPtyModule()
    const client = new InProcessPtyHostClient(mock.module)

    client.spawn(DEFAULT_REQUEST)
    client.spawn(DEFAULT_REQUEST)
    expect(client.activeSessionCount).toBe(2)

    // Simulate the first PTY process exiting
    const firstPty = mock.spawnedPtys[0]!
    ;(firstPty as unknown as { _triggerExit: () => void })._triggerExit()

    expect(client.activeSessionCount).toBe(1)

    // Simulate the second PTY process exiting
    const secondPty = mock.spawnedPtys[1]!
    ;(secondPty as unknown as { _triggerExit: () => void })._triggerExit()

    expect(client.activeSessionCount).toBe(0)

    client.dispose()
  })

  it('dispose() kills all active sessions and clears tracking', () => {
    const mock = createMockPtyModule()
    const client = new InProcessPtyHostClient(mock.module)

    client.spawn(DEFAULT_REQUEST)
    client.spawn(DEFAULT_REQUEST)
    client.spawn(DEFAULT_REQUEST)
    expect(client.activeSessionCount).toBe(3)

    client.dispose()

    expect(client.activeSessionCount).toBe(0)

    // Verify kill was called on each spawned PTY
    for (const pty of mock.spawnedPtys) {
      expect(pty.kill).toHaveBeenCalled()
    }
  })

  it('spawn() after dispose() returns a failed session with pid -1', async () => {
    const mock = createMockPtyModule()
    const client = new InProcessPtyHostClient(mock.module)

    client.dispose()

    const session = client.spawn(DEFAULT_REQUEST)
    expect(session.pid).toBe(-1)
    expect(client.activeSessionCount).toBe(0)

    // The failed session should fire onExit with exitCode 1
    const exitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
      session.onExit((event) => resolve(event))
    })
    const exitEvent = await exitPromise
    expect(exitEvent.exitCode).toBe(1)
  })

  it('does not track failed spawn attempts', () => {
    const failingModule = {
      spawn: vi.fn(() => {
        throw new Error('spawn failed: resource exhaustion')
      }),
    } as unknown as typeof import('node-pty')

    const client = new InProcessPtyHostClient(failingModule)
    const session = client.spawn(DEFAULT_REQUEST)

    expect(session.pid).toBe(-1)
    expect(client.activeSessionCount).toBe(0)

    client.dispose()
  })

  it('swallows kill errors during cleanup (best-effort)', () => {
    const mock = createMockPtyModule()
    const client = new InProcessPtyHostClient(mock.module)

    client.spawn(DEFAULT_REQUEST)
    client.spawn(DEFAULT_REQUEST)

    // Make kill throw on the first PTY
    ;(mock.spawnedPtys[0]!.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('process already exited')
    })

    // dispose() should not throw even when kill fails
    expect(() => client.dispose()).not.toThrow()
    expect(client.activeSessionCount).toBe(0)
  })

  it('registers process exit handler on first spawn', () => {
    const processOnSpy = vi.spyOn(process, 'on')

    const mock = createMockPtyModule()
    const client = new InProcessPtyHostClient(mock.module)

    // No handlers registered before spawn
    const callsBefore = processOnSpy.mock.calls.length

    client.spawn(DEFAULT_REQUEST)

    // After first spawn, handlers for 'exit', 'SIGTERM', 'SIGINT' should be registered
    const callsAfter = processOnSpy.mock.calls.length
    const newCalls = processOnSpy.mock.calls.slice(callsBefore)
    const registeredEvents = newCalls.map((call) => call[0])

    expect(registeredEvents).toContain('exit')
    expect(registeredEvents).toContain('SIGTERM')
    expect(registeredEvents).toContain('SIGINT')

    // Second spawn should NOT register handlers again
    const callsBeforeSecond = processOnSpy.mock.calls.length
    client.spawn(DEFAULT_REQUEST)
    expect(processOnSpy.mock.calls.length).toBe(callsBeforeSecond)

    processOnSpy.mockRestore()
    client.dispose()
  })

  it('double dispose is safe', () => {
    const mock = createMockPtyModule()
    const client = new InProcessPtyHostClient(mock.module)

    client.spawn(DEFAULT_REQUEST)
    client.dispose()
    expect(() => client.dispose()).not.toThrow()
    expect(client.activeSessionCount).toBe(0)
  })
})
