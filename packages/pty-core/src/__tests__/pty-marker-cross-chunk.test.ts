/**
 * P1-FUN-3: Marker 跨 chunk 拆分检测
 *
 * 验证 end marker prefix 被拆分到多个 PTY data 事件中时，
 * PtyCommandRunner 仍然能正确检测并解析 marker。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PtyCommandRunner } from '../PtyCommandRunner'
import { PtySessionStore } from '../PtySessionStore'
import { PtyOutputBuffer } from '../PtyOutputBuffer'
import { MAX_OUTPUT_BUFFER_BYTES } from '../marker/constants'
import type { PtySession } from '../PtySessionStore'
import type { PtyHostSession } from '../PtyHost'

function createMockPtyHostSession(): PtyHostSession {
  return {
    pid: 12345,
    write: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
    pauseOutput: vi.fn(),
    resumeOutput: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    onSpawned: vi.fn(() => ({ dispose: vi.fn() })),
  }
}

function createSession(store: PtySessionStore, id = 'test-session'): PtySession {
  const now = Date.now()
  const session: PtySession = {
    id,
    pty: createMockPtyHostSession(),
    cwd: '/tmp',
    createdAt: now,
    outputBuffer: new PtyOutputBuffer(MAX_OUTPUT_BUFFER_BYTES),
    lastOutputAt: now,
    pid: 12345,
    isRunning: true,
    lastExitCode: null,
    lastCommandCompletedAt: null,
    terminationFinalized: false,
  }
  store.createSession(session)
  return session
}

/** Extract start marker and end marker prefix from the written command string */
function extractMarkers(written: string) {
  const startMarkerMatch = written.match(/echo "(__TABTIN_CMD_START_[^"]+)"/)
  const endMarkerMatch = written.match(/echo "(__TABTIN_CMD_END_[a-f0-9]+_)\$\?/)
  return {
    startMarker: startMarkerMatch![1],
    endMarkerPrefix: endMarkerMatch![1],
  }
}

describe('P1-FUN-3: Marker cross-chunk split detection', () => {
  let store: PtySessionStore
  let writeFn: ReturnType<typeof vi.fn>
  let runner: PtyCommandRunner

  beforeEach(() => {
    store = new PtySessionStore()
    writeFn = vi.fn(() => true)
    runner = new PtyCommandRunner({ store, write: writeFn })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects marker when fully contained in a single chunk', async () => {
    const session = createSession(store)
    const resultPromise = runner.execute(session.id, 'echo hello', {
      blockUntilMs: 5000,
    })

    const { startMarker, endMarkerPrefix } = extractMarkers(writeFn.mock.calls[0][1])

    // All data in one chunk
    session.outputBuffer.append(`${startMarker}\nhello\n${endMarkerPrefix}0\x1F/tmp__\n`)
    runner.handleData(session.id)

    const result = await resultPromise
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('hello')
    expect(result.backgrounded).toBe(false)
  })

  it('detects marker when split exactly in the middle across two chunks', async () => {
    const session = createSession(store)
    const resultPromise = runner.execute(session.id, 'echo hello', {
      blockUntilMs: 5000,
    })

    const { startMarker, endMarkerPrefix } = extractMarkers(writeFn.mock.calls[0][1])

    // Chunk 1: start marker + output + first half of end marker prefix
    const midpoint = Math.floor(endMarkerPrefix.length / 2)
    const firstHalf = endMarkerPrefix.substring(0, midpoint)
    const secondHalf = endMarkerPrefix.substring(midpoint)

    session.outputBuffer.append(`${startMarker}\nhello\n${firstHalf}`)
    runner.handleData(session.id) // should NOT resolve yet, but should keep overlap

    // Chunk 2: second half of end marker prefix + tail
    session.outputBuffer.append(`${secondHalf}0\x1F/tmp__\n`)
    runner.handleData(session.id)

    const result = await resultPromise
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('hello')
    expect(result.backgrounded).toBe(false)
  })

  it('detects marker when split at the very beginning (1 char in first chunk)', async () => {
    const session = createSession(store)
    const resultPromise = runner.execute(session.id, 'echo hello', {
      blockUntilMs: 5000,
    })

    const { startMarker, endMarkerPrefix } = extractMarkers(writeFn.mock.calls[0][1])

    // Chunk 1: start marker + output + just the first character of end marker prefix
    const firstChar = endMarkerPrefix.substring(0, 1)
    const rest = endMarkerPrefix.substring(1)

    session.outputBuffer.append(`${startMarker}\nhello\n${firstChar}`)
    runner.handleData(session.id)

    // Chunk 2: rest of end marker prefix + tail
    session.outputBuffer.append(`${rest}0\x1F/tmp__\n`)
    runner.handleData(session.id)

    const result = await resultPromise
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('hello')
    expect(result.backgrounded).toBe(false)
  })

  it('detects marker when split at the very end (all but last char in first chunk)', async () => {
    const session = createSession(store)
    const resultPromise = runner.execute(session.id, 'echo hello', {
      blockUntilMs: 5000,
    })

    const { startMarker, endMarkerPrefix } = extractMarkers(writeFn.mock.calls[0][1])

    // Chunk 1: everything except the last character of end marker prefix
    const allButLast = endMarkerPrefix.substring(0, endMarkerPrefix.length - 1)
    const lastChar = endMarkerPrefix.substring(endMarkerPrefix.length - 1)

    session.outputBuffer.append(`${startMarker}\nhello\n${allButLast}`)
    runner.handleData(session.id)

    // Chunk 2: last char + tail
    session.outputBuffer.append(`${lastChar}0\x1F/tmp__\n`)
    runner.handleData(session.id)

    const result = await resultPromise
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('hello')
    expect(result.backgrounded).toBe(false)
  })

  it('detects marker split across three chunks', async () => {
    const session = createSession(store)
    const resultPromise = runner.execute(session.id, 'echo hello', {
      blockUntilMs: 5000,
    })

    const { startMarker, endMarkerPrefix } = extractMarkers(writeFn.mock.calls[0][1])

    const third = Math.floor(endMarkerPrefix.length / 3)
    const part1 = endMarkerPrefix.substring(0, third)
    const part2 = endMarkerPrefix.substring(third, third * 2)
    const part3 = endMarkerPrefix.substring(third * 2)

    session.outputBuffer.append(`${startMarker}\nhello\n${part1}`)
    runner.handleData(session.id)

    session.outputBuffer.append(part2)
    runner.handleData(session.id)

    session.outputBuffer.append(`${part3}0\x1F/tmp__\n`)
    runner.handleData(session.id)

    const result = await resultPromise
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('hello')
    expect(result.backgrounded).toBe(false)
  })

  it('does not resolve early when only the end marker prefix has arrived', async () => {
    const session = createSession(store)
    const resolved = vi.fn()
    const resultPromise = runner.execute(session.id, 'echo hello', {
      blockUntilMs: 5000,
    }).then((result) => {
      resolved(result)
      return result
    })

    const { startMarker, endMarkerPrefix } = extractMarkers(writeFn.mock.calls[0][1])

    session.outputBuffer.append(`${startMarker}\nhello\n${endMarkerPrefix}`)
    runner.handleData(session.id)

    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()

    session.outputBuffer.append('0\x1F/tmp__\n')
    runner.handleData(session.id)

    const result = await resultPromise
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('hello')
  })

  it('carries pending marker overlap into backgrounded watcher after timeout', async () => {
    vi.useFakeTimers()
    try {
      const session = createSession(store)
      const resultPromise = runner.execute(session.id, 'echo hello', {
        blockUntilMs: 1,
      })

      const { startMarker, endMarkerPrefix } = extractMarkers(writeFn.mock.calls[0][1])
      const third = Math.floor(endMarkerPrefix.length / 3)
      const part1 = endMarkerPrefix.substring(0, third)
      const part2 = endMarkerPrefix.substring(third, third * 2)
      const part3 = endMarkerPrefix.substring(third * 2)

      session.outputBuffer.append(`${startMarker}\nhello\n${part1}`)
      runner.handleData(session.id)

      session.outputBuffer.append(part2)
      runner.handleData(session.id)

      await vi.advanceTimersByTimeAsync(1)
      const timedOut = await resultPromise
      expect(timedOut.backgrounded).toBe(true)
      expect(timedOut.timedOut).toBe(true)

      session.outputBuffer.append(`${part3}0\x1F/home/user__\n`)
      runner.handleData(session.id)

      expect(session.lastExitCode).toBe(0)
      expect(session.cwd).toBe('/home/user')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not regress: multiple handleData calls without marker do not cause issues', async () => {
    const session = createSession(store)
    const resultPromise = runner.execute(session.id, 'long-cmd', {
      blockUntilMs: 5000,
    })

    const { startMarker, endMarkerPrefix } = extractMarkers(writeFn.mock.calls[0][1])

    session.outputBuffer.append(`${startMarker}\n`)
    runner.handleData(session.id)

    // Many chunks of output with no marker
    for (let i = 0; i < 20; i++) {
      session.outputBuffer.append(`line ${i}\n`)
      runner.handleData(session.id)
    }

    // Finally the end marker in one piece
    session.outputBuffer.append(`${endMarkerPrefix}0\x1F/home/user__\n`)
    runner.handleData(session.id)

    const result = await resultPromise
    expect(result.exitCode).toBe(0)
    expect(result.cwd).toBe('/home/user')
    expect(result.backgrounded).toBe(false)
  })

  describe('backgrounded watcher cross-chunk detection', () => {
    it('detects split marker for backgrounded command', async () => {
      const session = createSession(store)
      // Fire-and-forget (blockUntilMs=0 → immediately backgrounded)
      const result = await runner.execute(session.id, 'sleep 1', { blockUntilMs: 0 })
      expect(result.backgrounded).toBe(true)

      const written = writeFn.mock.calls[0][1] as string
      const endMarkerMatch = written.match(/echo "(__TABTIN_CMD_END_[a-f0-9]+_)\$\?/)!
      const endMarkerPrefix = endMarkerMatch[1]

      // Split the marker across two chunks
      const midpoint = Math.floor(endMarkerPrefix.length / 2)
      session.outputBuffer.append(endMarkerPrefix.substring(0, midpoint))
      runner.handleData(session.id)

      session.outputBuffer.append(`${endMarkerPrefix.substring(midpoint)}0\x1F/home/user__\n`)
      runner.handleData(session.id)

      expect(session.lastExitCode).toBe(0)
      expect(session.cwd).toBe('/home/user')
    })
  })
})
