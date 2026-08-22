import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PtySessionStore } from '../PtySessionStore'
import type { PtySession, PendingCommand, ExecuteCommandResult } from '../PtySessionStore'
import { PtyOutputBuffer } from '../PtyOutputBuffer'
import { PtyProcessTerminator } from '../PtyProcessTerminator'
import type { PtyProcessTerminatorDeps } from '../PtyProcessTerminator'

// ── Helpers ──

function makeDummySession(id: string, cwd = '/tmp'): PtySession {
  return {
    id,
    pty: {} as PtySession['pty'],
    cwd,
    createdAt: Date.now(),
    outputBuffer: new PtyOutputBuffer(256 * 1024),
    lastOutputAt: Date.now(),
    pid: 12345,
    isRunning: true,
    lastExitCode: null,
    lastCommandCompletedAt: null,
  }
}

// ── PC-5: deleteSession cascades pendingCommands & backgroundedWatchers ──

describe('PC-5: deleteSession cascade cleanup', () => {
  let store: PtySessionStore

  beforeEach(() => {
    store = new PtySessionStore()
  })

  it('should resolve pending promise when session is deleted', async () => {
    const session = makeDummySession('sess-1')
    store.createSession(session)

    let resolved: ExecuteCommandResult | undefined
    const promise = new Promise<ExecuteCommandResult>((resolve) => {
      const pending: PendingCommand = {
        nonce: 'nonce-1',
        startMarker: '__START__',
        endMarkerPrefix: '__END__',
        startedAt: Date.now(),
        bufferStartCursor: 0,
        resolve,
        timer: null,
        sessionId: 'sess-1',
      }
      store.setPendingCommand('sess-1', pending)
    })

    promise.then((r) => { resolved = r })

    // deleteSession should resolve the pending promise
    store.deleteSession('sess-1')

    // Allow microtask queue to flush
    await new Promise((r) => setTimeout(r, 10))

    expect(resolved).toBeDefined()
    expect(resolved!.sessionId).toBe('sess-1')
    expect(resolved!.exitCode).toBeNull()
    expect(resolved!.backgrounded).toBe(false)
  })

  it('should clear the pending timer when session is deleted', () => {
    const session = makeDummySession('sess-2')
    store.createSession(session)

    const timer = setTimeout(() => {}, 60_000)
    const clearSpy = vi.spyOn(global, 'clearTimeout')

    const pending: PendingCommand = {
      nonce: 'nonce-2',
      startMarker: '__START__',
      endMarkerPrefix: '__END__',
      startedAt: Date.now(),
      bufferStartCursor: 0,
      resolve: () => {},
      timer,
      sessionId: 'sess-2',
    }
    store.setPendingCommand('sess-2', pending)

    store.deleteSession('sess-2')

    expect(clearSpy).toHaveBeenCalledWith(timer)
    clearSpy.mockRestore()
  })

  it('should remove pending command from store after deleteSession', () => {
    const session = makeDummySession('sess-3')
    store.createSession(session)

    store.setPendingCommand('sess-3', {
      nonce: 'n',
      startMarker: 's',
      endMarkerPrefix: 'e',
      startedAt: Date.now(),
      bufferStartCursor: 0,
      resolve: () => {},
      timer: null,
      sessionId: 'sess-3',
    })

    expect(store.hasPendingCommand('sess-3')).toBe(true)
    store.deleteSession('sess-3')
    expect(store.hasPendingCommand('sess-3')).toBe(false)
  })

  it('should remove backgrounded watchers when session is deleted', () => {
    const session = makeDummySession('sess-4')
    store.createSession(session)

    store.setBackgroundedWatchers('sess-4', [
      {
        endMarkerPrefix: '__END__',
        sessionId: 'sess-4',
        createdAt: Date.now(),
        bufferSearchCursor: 0,
      },
    ])

    expect(store.getBackgroundedWatchers('sess-4')).toBeDefined()
    store.deleteSession('sess-4')
    expect(store.getBackgroundedWatchers('sess-4')).toBeUndefined()
  })

  it('should not throw when session has no pending commands or watchers', () => {
    const session = makeDummySession('sess-5')
    store.createSession(session)

    expect(() => store.deleteSession('sess-5')).not.toThrow()
  })
})

// ── PC-6: force-kill timer cancellable + default guard ──

describe('PC-6: terminateTree cancel and guard', () => {
  it('should return a handle with cancel() that prevents force-kill', async () => {
    const killed: Array<{ pid: number; signal: string }> = []
    let scheduledCallback: (() => void) | null = null

    const deps: PtyProcessTerminatorDeps = {
      collectProcessTable: async () => new Map(),
      killProcess: (pid, signal) => { killed.push({ pid, signal }) },
      schedule: (cb, _delayMs) => {
        scheduledCallback = cb
        return setTimeout(() => {}, 0) // return a real timer handle
      },
    }

    const terminator = new PtyProcessTerminator(deps)
    const handle = terminator.terminateTree(100, {
      guard: () => true,
    })

    // Cancel before the scheduled callback fires
    handle.cancel()

    // Simulate the timer firing after cancel
    if (scheduledCallback) scheduledCallback()

    // Wait for async killProcessTree
    await new Promise((r) => setTimeout(r, 50))

    // Only the graceful SIGTERM should have been sent, not the force SIGKILL
    expect(killed).toHaveLength(1)
    expect(killed[0].signal).toBe('SIGTERM')
  })

  it('should use default guard that checks PID existence', async () => {
    const killed: Array<{ pid: number; signal: string }> = []
    let scheduledCallback: (() => void) | null = null

    const deps: PtyProcessTerminatorDeps = {
      collectProcessTable: async () => new Map(),
      killProcess: (pid, signal) => { killed.push({ pid, signal }) },
      schedule: (cb, _delayMs) => {
        scheduledCallback = cb
        return setTimeout(() => {}, 0)
      },
    }

    const terminator = new PtyProcessTerminator(deps)

    // Use a PID that definitely doesn't exist (very high number)
    // The default guard should return false for a non-existent PID
    terminator.terminateTree(999999999, {
      // No guard provided — default guard will be used
    })

    // Simulate the timer firing
    if (scheduledCallback) scheduledCallback()

    await new Promise((r) => setTimeout(r, 50))

    // Graceful signal is always sent; force-kill should be skipped by default
    // guard because PID 999999999 doesn't exist
    const forceKills = killed.filter(k => k.signal === 'SIGKILL')
    expect(forceKills).toHaveLength(0)
  })

  it('should still force-kill when guard returns true', async () => {
    const killed: Array<{ pid: number; signal: string }> = []
    let scheduledCallback: (() => void) | null = null

    const deps: PtyProcessTerminatorDeps = {
      collectProcessTable: async () => new Map(),
      killProcess: (pid, signal) => { killed.push({ pid, signal }) },
      schedule: (cb, _delayMs) => {
        scheduledCallback = cb
        return setTimeout(() => {}, 0)
      },
    }

    const terminator = new PtyProcessTerminator(deps)
    terminator.terminateTree(100, {
      guard: () => true,
    })

    // Simulate the timer firing
    if (scheduledCallback) scheduledCallback()

    await new Promise((r) => setTimeout(r, 50))

    const forceKills = killed.filter(k => k.signal === 'SIGKILL')
    expect(forceKills).toHaveLength(1)
  })

  it('should return noop handle for invalid PID', () => {
    const terminator = new PtyProcessTerminator()
    const handle = terminator.terminateTree(-1)
    // Should not throw
    expect(() => handle.cancel()).not.toThrow()
  })
})

// ── PC-1: single chunk exceeding maxBytes gets truncated ──

describe('PC-1: PtyOutputBuffer oversized chunk truncation', () => {
  it('should truncate a single chunk that exceeds maxBytes', () => {
    const maxBytes = 100
    const buffer = new PtyOutputBuffer(maxBytes)

    // Create a string that is definitely larger than maxBytes
    const oversized = 'A'.repeat(500)
    buffer.append(oversized)

    expect(buffer.getTotalBytes()).toBeLessThanOrEqual(maxBytes)
    expect(buffer.getChunkCount()).toBe(1)
  })

  it('should keep the tail of the oversized chunk', () => {
    const maxBytes = 50
    const buffer = new PtyOutputBuffer(maxBytes)

    // Create a string where the tail is identifiable
    const prefix = 'X'.repeat(100)
    const suffix = 'END_MARKER_DATA'
    const oversized = prefix + suffix
    buffer.append(oversized)

    const content = buffer.readAll()
    // The tail (including END_MARKER_DATA) should be preserved
    expect(content).toContain('END_MARKER_DATA')
    expect(buffer.getTotalBytes()).toBeLessThanOrEqual(maxBytes)
  })

  it('should handle chunks exactly at maxBytes without truncation', () => {
    const maxBytes = 100
    const buffer = new PtyOutputBuffer(maxBytes)

    // ASCII: 1 byte per char
    const exact = 'B'.repeat(100)
    buffer.append(exact)

    expect(buffer.readAll()).toBe(exact)
    expect(buffer.getTotalBytes()).toBe(100)
  })

  it('should handle chunks smaller than maxBytes normally', () => {
    const maxBytes = 1000
    const buffer = new PtyOutputBuffer(maxBytes)

    buffer.append('hello')
    expect(buffer.readAll()).toBe('hello')
    expect(buffer.getTotalBytes()).toBe(5)
  })

  it('should still evict old chunks normally after truncation', () => {
    const maxBytes = 100
    const buffer = new PtyOutputBuffer(maxBytes)

    // First: a normal small chunk
    buffer.append('small')
    // Second: an oversized chunk — will be truncated to maxBytes
    buffer.append('Y'.repeat(200))

    // The small chunk should have been evicted since the truncated chunk
    // fills up to maxBytes
    expect(buffer.readAll()).not.toContain('small')
    expect(buffer.getTotalBytes()).toBeLessThanOrEqual(maxBytes)
  })

  it('should handle multi-byte UTF-8 characters gracefully', () => {
    const maxBytes = 50
    const buffer = new PtyOutputBuffer(maxBytes)

    // Each emoji is 4 bytes in UTF-8
    const oversized = '\u{1F600}'.repeat(50) // 200 bytes
    buffer.append(oversized)

    expect(buffer.getTotalBytes()).toBeLessThanOrEqual(maxBytes)
    // Should not throw or produce invalid UTF-8
    const content = buffer.readAll()
    expect(typeof content).toBe('string')
  })
})
