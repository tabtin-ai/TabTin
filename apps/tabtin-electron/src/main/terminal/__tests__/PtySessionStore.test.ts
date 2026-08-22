import { describe, expect, it, vi } from 'vitest'
import type { PtyHostSession } from '../PtyHost'
import { PtyOutputBuffer } from '../PtyOutputBuffer'
import { PtyWriteChannel } from '../PtyWriteChannel'
import {
  PtySessionStore,
  type PendingCommand,
  type PtySession,
} from '../PtySessionStore'

const createMockPty = (): PtyHostSession =>
  ({
    pid: 42,
    onSpawned: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    pauseOutput: vi.fn(),
    resumeOutput: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
  })

const createSession = (id: string): PtySession => {
  const pty = createMockPty()
  return {
    id,
    pty,
    writeChannel: new PtyWriteChannel(pty),
    cwd: '/tmp',
    createdAt: Date.now(),
    outputBuffer: new PtyOutputBuffer(128),
    lastOutputAt: Date.now(),
    pid: 42,
    isRunning: true,
    lastExitCode: null,
    lastCommandCompletedAt: null,
  }
}

const createPendingCommand = (sessionId: string): PendingCommand => ({
  nonce: 'nonce',
  startMarker: 'start',
  endMarkerPrefix: 'end',
  startedAt: Date.now(),
  bufferStartCursor: 0,
  resolve: vi.fn(),
  timer: null,
  sessionId,
})

describe('PtySessionStore', () => {
  it('管理 session 与 thread 映射，并在删除 session 时释放对应 thread', () => {
    const store = new PtySessionStore()
    const session = createSession('session-a')

    store.createSession(session)
    store.setThreadSession('thread-1', session.id)

    expect(store.getSession('session-a')).toBe(session)
    expect(store.getThreadSession('thread-1')).toBe('session-a')

    store.deleteSession('session-a')

    expect(store.getSession('session-a')).toBeUndefined()
    expect(store.getThreadSession('thread-1')).toBeUndefined()
  })

  it('支持 pending command 与 background watcher 的独立存取和清理', () => {
    const store = new PtySessionStore()
    const pending = createPendingCommand('session-b')

    store.setPendingCommand('session-b', pending)
    store.setBackgroundedWatchers('session-b', [
      {
        endMarkerPrefix: 'marker',
        sessionId: 'session-b',
        createdAt: Date.now(),
        bufferSearchCursor: 3,
      },
    ])

    expect(store.getPendingCommand('session-b')).toBe(pending)
    expect(store.hasPendingCommand('session-b')).toBe(true)
    expect(store.getBackgroundedWatchers('session-b')).toHaveLength(1)

    expect(store.deletePendingCommand('session-b')).toBe(pending)
    store.deleteBackgroundedWatchers('session-b')

    expect(store.hasPendingCommand('session-b')).toBe(false)
    expect(store.getBackgroundedWatchers('session-b')).toBeUndefined()
  })
})
