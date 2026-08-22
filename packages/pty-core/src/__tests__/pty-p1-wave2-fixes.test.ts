/**
 * Regression tests for Wave 2 P1 fixes.
 * Covers: PC-1, PC-9, PC-12, PC-14, PC-15, PC-16, PC-17, PC-18, PC-20
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateMarkerPair } from '../marker/generator'
import { wrapCommand, detectShellType } from '../marker/command-wrapper'
import { PtyOutputBuffer } from '../PtyOutputBuffer'
import { PtySessionStore } from '../PtySessionStore'
import { PtyCommandRunner } from '../PtyCommandRunner'
import { MAX_OUTPUT_BUFFER_BYTES, MARKER_PREFIX } from '../marker/constants'
import type { PtySession } from '../PtySessionStore'
import type { PtyHostSession } from '../PtyHost'

// ── Helpers ──

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

function createSession(store: PtySessionStore, id = 'test-session', maxBytes = MAX_OUTPUT_BUFFER_BYTES): PtySession {
  const now = Date.now()
  const session: PtySession = {
    id,
    pty: createMockPtyHostSession(),
    cwd: '/tmp',
    createdAt: now,
    outputBuffer: new PtyOutputBuffer(maxBytes),
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

// ── PC-9: 标记注入风险 — nonce 增强到 128 bit ──

describe('PC-9: marker nonce strength', () => {
  it('generates nonce with 32 hex characters (128 bits)', () => {
    const markers = generateMarkerPair()
    // endMarkerPrefix format: __TABTIN_CMD_END_{nonce}_
    const match = markers.endMarkerPrefix.match(/__TABTIN_CMD_END_([a-f0-9]+)_/)
    expect(match).not.toBeNull()
    expect(match![1]).toHaveLength(32)
  })

  it('generates unique nonces on each call', () => {
    const nonces = new Set<string>()
    for (let i = 0; i < 100; i++) {
      nonces.add(generateMarkerPair().nonce)
    }
    expect(nonces.size).toBe(100)
  })

  it('uses only lowercase hex characters in nonce', () => {
    const markers = generateMarkerPair()
    expect(markers.nonce).toMatch(/^[a-f0-9]{32}$/)
  })
})

// ── PC-20: start and end markers use different nonces ──

describe('PC-20: separate nonces for start and end markers', () => {
  it('start marker nonce differs from end marker nonce', () => {
    const markers = generateMarkerPair()
    const startMatch = markers.startMarker.match(/__TABTIN_CMD_START_([a-f0-9]+)__/)
    const endMatch = markers.endMarkerPrefix.match(/__TABTIN_CMD_END_([a-f0-9]+)_/)
    expect(startMatch).not.toBeNull()
    expect(endMatch).not.toBeNull()
    expect(startMatch![1]).not.toBe(endMatch![1])
  })

  it('markers.nonce matches the end marker nonce (for PendingCommand storage)', () => {
    const markers = generateMarkerPair()
    expect(markers.endMarkerPrefix).toContain(markers.nonce)
    expect(markers.startMarker).not.toContain(markers.nonce)
  })

  it('child process cannot forge end marker from observing start marker echo', () => {
    const markers = generateMarkerPair()
    // Extract the nonce from the start marker (what a child process sees)
    const startNonce = markers.startMarker.match(/__TABTIN_CMD_START_([a-f0-9]+)__/)![1]
    // Construct a fake end marker using the start nonce
    const fakeEndMarker = `__TABTIN_CMD_END_${startNonce}_`
    // This should NOT match the real end marker prefix
    expect(fakeEndMarker).not.toBe(markers.endMarkerPrefix)
  })
})

// ── PC-12: 测试标记前缀与实际代码一致 ──

describe('PC-12: marker prefix consistency', () => {
  it('generated start marker uses __TABTIN_CMD_START_ prefix', () => {
    const markers = generateMarkerPair()
    expect(markers.startMarker).toMatch(/^__TABTIN_CMD_START_/)
  })

  it('generated end marker prefix uses __TABTIN_CMD_END_ prefix', () => {
    const markers = generateMarkerPair()
    expect(markers.endMarkerPrefix).toMatch(/^__TABTIN_CMD_END_/)
  })

  it('MARKER_PREFIX constant is __TABTIN_CMD_', () => {
    expect(MARKER_PREFIX).toBe('__TABTIN_CMD_')
  })
})

// ── PC-14: hasOverflowed 语义 — sticky flag ──

describe('PC-14: hasOverflowed sticky semantics', () => {
  it('returns false when no chunks have been evicted', () => {
    const buffer = new PtyOutputBuffer(1000)
    buffer.append('small data')
    expect(buffer.hasOverflowed()).toBe(false)
  })

  it('returns true after chunks are evicted', () => {
    const buffer = new PtyOutputBuffer(100)
    buffer.append('A'.repeat(60))
    buffer.append('B'.repeat(60))
    // Second append should evict the first chunk
    expect(buffer.hasOverflowed()).toBe(true)
  })

  it('remains true even after totalBytes drops below maxBytes', () => {
    const buffer = new PtyOutputBuffer(100)
    // Fill and overflow
    buffer.append('A'.repeat(60))
    buffer.append('B'.repeat(60))
    expect(buffer.hasOverflowed()).toBe(true)

    // totalBytes is now ≤ 100 (only 'B' chunk remains), but flag stays true
    expect(buffer.getTotalBytes()).toBeLessThanOrEqual(100)
    expect(buffer.hasOverflowed()).toBe(true)
  })

  it('returns true after single oversized chunk causes truncation and eviction', () => {
    const buffer = new PtyOutputBuffer(100)
    buffer.append('first chunk')
    buffer.append('A'.repeat(200)) // oversized, truncated; first chunk evicted
    expect(buffer.hasOverflowed()).toBe(true)
  })
})

// ── PC-15: releaseThreadSessionBySessionId 释放所有匹配 ──

describe('PC-15: releaseThreadSessionBySessionId releases all matches', () => {
  let store: PtySessionStore

  beforeEach(() => {
    store = new PtySessionStore()
  })

  it('releases all threads bound to the same session', () => {
    store.setThreadSession('thread-1', 'session-A')
    store.setThreadSession('thread-2', 'session-A')
    store.setThreadSession('thread-3', 'session-B')

    store.releaseThreadSessionBySessionId('session-A')

    expect(store.getThreadSession('thread-1')).toBeUndefined()
    expect(store.getThreadSession('thread-2')).toBeUndefined()
    // thread-3 should be untouched
    expect(store.getThreadSession('thread-3')).toBe('session-B')
  })

  it('does not throw when no threads match', () => {
    store.setThreadSession('thread-1', 'session-X')
    expect(() => store.releaseThreadSessionBySessionId('session-Y')).not.toThrow()
    expect(store.getThreadSession('thread-1')).toBe('session-X')
  })

  it('handles single thread correctly', () => {
    store.setThreadSession('thread-1', 'session-A')
    store.releaseThreadSessionBySessionId('session-A')
    expect(store.getThreadSession('thread-1')).toBeUndefined()
  })
})

// ── PC-16: InProcessPtyHost spawn 失败行为 ──

describe('PC-16: InProcessPtyHostClient spawn failure', () => {
  it('returns a FailedPtyHostSession when spawn throws', async () => {
    // Import dynamically since it requires node-pty
    const { InProcessPtyHostClient } = await import('../InProcessPtyHost')

    const fakeModule = {
      spawn: () => { throw new Error('spawn failed: no such shell') },
    } as any

    const client = new InProcessPtyHostClient(fakeModule)
    const session = client.spawn({
      shell: '/nonexistent/shell',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: {},
    })

    // Should not throw
    expect(session).toBeDefined()
    expect(session.pid).toBe(-1)

    // onSpawned should never fire
    const spawnedSpy = vi.fn()
    session.onSpawned(spawnedSpy)
    await new Promise((r) => setTimeout(r, 50))
    expect(spawnedSpy).not.toHaveBeenCalled()

    // onExit should fire with exitCode=1
    const exitSpy = vi.fn()
    session.onExit(exitSpy)
    await new Promise((r) => setTimeout(r, 50))
    expect(exitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: 1 }),
    )

    // write/kill/resize should be no-ops, not throw
    expect(() => session.write('test')).not.toThrow()
    expect(() => session.kill()).not.toThrow()
    expect(() => session.resize(120, 40)).not.toThrow()
  })
})

// ── PC-17: multi-shell marker protocol ──

describe('PC-17: wrapCommand multi-shell support', () => {
  const markers = generateMarkerPair()

  describe('detectShellType', () => {
    it('detects fish', () => {
      expect(detectShellType('/usr/bin/fish')).toBe('fish')
    })

    it('detects powershell', () => {
      expect(detectShellType('/usr/bin/pwsh')).toBe('powershell')
      expect(detectShellType('C:\\Windows\\System32\\powershell.exe')).toBe('powershell')
      expect(detectShellType('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell')
    })

    it('defaults to posix for bash/zsh/sh', () => {
      expect(detectShellType('/bin/bash')).toBe('posix')
      expect(detectShellType('/bin/zsh')).toBe('posix')
      expect(detectShellType('/bin/sh')).toBe('posix')
    })
  })

  describe('posix (default)', () => {
    it('generates valid bash syntax', () => {
      const result = wrapCommand('echo hello', markers)
      expect(result).toContain('echo "')
      expect(result).toContain('$?')
      expect(result).toContain('$(pwd)')
    })
  })

  describe('fish shell', () => {
    it('uses fish syntax for env vars', () => {
      const result = wrapCommand('echo hello', markers, {
        shellType: 'fish',
        env: { MY_VAR: 'value' },
      })
      expect(result).toContain("set -x MY_VAR 'value'")
      expect(result).not.toContain('export')
    })

    it('uses $status instead of $?', () => {
      const result = wrapCommand('echo hello', markers, { shellType: 'fish' })
      expect(result).toContain('$status')
      expect(result).not.toContain('$?')
    })

    it('uses (pwd) instead of $(pwd)', () => {
      const result = wrapCommand('echo hello', markers, { shellType: 'fish' })
      expect(result).toContain('(pwd)')
    })

    it('uses cd with fish quoting', () => {
      const result = wrapCommand('ls', markers, {
        shellType: 'fish',
        workingDirectory: "/tmp/it's a test",
      })
      expect(result).toContain("cd '/tmp/it\\'s a test'")
    })

    it('chains commands with ; and', () => {
      const result = wrapCommand('ls', markers, {
        shellType: 'fish',
        env: { A: '1' },
      })
      expect(result).toContain('; and')
    })
  })

  describe('powershell', () => {
    it('uses Write-Host instead of echo', () => {
      const result = wrapCommand('echo hello', markers, { shellType: 'powershell' })
      expect(result).toContain('Write-Host')
    })

    it('uses $env: prefix for env vars', () => {
      const result = wrapCommand('ls', markers, {
        shellType: 'powershell',
        env: { MY_VAR: 'value' },
      })
      expect(result).toContain("$env:MY_VAR = 'value'")
    })

    it('uses Set-Location instead of cd', () => {
      const result = wrapCommand('ls', markers, {
        shellType: 'powershell',
        workingDirectory: '/tmp/test',
      })
      expect(result).toContain("Set-Location '/tmp/test'")
    })

    it('uses $LASTEXITCODE', () => {
      const result = wrapCommand('ls', markers, { shellType: 'powershell' })
      expect(result).toContain('$LASTEXITCODE')
    })
  })
})

// ── PC-1: buffer overflow immediately resolves command as backgrounded ──

describe('PC-1: buffer overflow resolves command as backgrounded', () => {
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

  it('resolves as backgrounded when buffer overflows and start cursor is evicted', async () => {
    // Use a very small buffer to trigger overflow easily
    const session = createSession(store, 'overflow-session', 200)
    const resultPromise = runner.execute(session.id, 'generate-large-output', {
      blockUntilMs: 30000,
    })

    // The command is now pending. Simulate lots of output that overflows the buffer.
    for (let i = 0; i < 20; i++) {
      session.outputBuffer.append('X'.repeat(50))
      runner.handleData(session.id)
    }

    const result = await resultPromise
    expect(result.backgrounded).toBe(true)
    expect(result.exitCode).toBeNull()
    // Command should no longer be pending
    expect(store.hasPendingCommand(session.id)).toBe(false)
  })
})

// ── PC-18: timeout/marker race condition ──

describe('PC-18: timeout-marker race condition', () => {
  let store: PtySessionStore
  let writeFn: ReturnType<typeof vi.fn>
  let runner: PtyCommandRunner

  beforeEach(() => {
    vi.useFakeTimers()
    store = new PtySessionStore()
    writeFn = vi.fn(() => true)
    runner = new PtyCommandRunner({ store, write: writeFn })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('timeout does not add residual watcher when marker already resolved', async () => {
    const session = createSession(store)
    const resultPromise = runner.execute(session.id, 'echo test', {
      blockUntilMs: 5000,
    })

    // Extract markers from the written command
    const written = writeFn.mock.calls[0][1] as string
    const startMarkerMatch = written.match(/echo "(__TABTIN_CMD_START_[^"]+)"/)!
    const endMarkerMatch = written.match(/echo "(__TABTIN_CMD_END_[a-f0-9]+_)\$/)!
    const startMarker = startMarkerMatch[1]
    const endMarkerPrefix = endMarkerMatch[1]

    // Simulate marker arriving before timeout
    session.outputBuffer.append(`${startMarker}\n`)
    session.outputBuffer.append('test output\n')
    session.outputBuffer.append(`${endMarkerPrefix}0_/tmp__\n`)
    runner.handleData(session.id)

    // Command should be resolved now
    const result = await resultPromise
    expect(result.exitCode).toBe(0)
    expect(result.backgrounded).toBe(false)

    // Now let the timeout fire
    vi.advanceTimersByTime(6000)

    // No backgrounded watcher should exist (PC-18 fix)
    expect(store.getBackgroundedWatchers(session.id)).toBeUndefined()
  })
})
