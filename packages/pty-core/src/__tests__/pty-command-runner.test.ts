/**
 * Unit tests for PtyCommandRunner.
 *
 * Uses in-memory PtySessionStore and PtyOutputBuffer stubs —
 * no real PTY process required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PtyCommandRunner } from '../PtyCommandRunner';
import { PtySessionStore } from '../PtySessionStore';
import { PtyOutputBuffer } from '../PtyOutputBuffer';
import { MAX_OUTPUT_BUFFER_BYTES } from '../marker/constants';
import type { PtySession } from '../PtySessionStore';
import type { PtyHostSession } from '../PtyHost';

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
  };
}

function createSession(store: PtySessionStore, id = 'test-session'): PtySession {
  const now = Date.now();
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
  };
  store.createSession(session);
  return session;
}

describe('PtyCommandRunner', () => {
  let store: PtySessionStore;
  let writeFn: ReturnType<typeof vi.fn>;
  let runner: PtyCommandRunner;

  beforeEach(() => {
    store = new PtySessionStore();
    writeFn = vi.fn(() => true);
    runner = new PtyCommandRunner({ store, write: writeFn });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── OutputBuffer integration ──

  describe('OutputBuffer integration', () => {
    it('handleData processes data already appended to the session outputBuffer', () => {
      const session = createSession(store);
      session.outputBuffer.append('hello world\n');
      runner.handleData(session.id);
      expect(session.outputBuffer.readAll()).toBe('hello world\n');
    });
  });

  // ── Marker detection ──

  describe('Marker-based command resolution', () => {
    it('resolves a command when end marker appears in output', async () => {
      const session = createSession(store);
      const resultPromise = runner.execute(session.id, 'echo hello', {
        blockUntilMs: 5000,
      });

      expect(writeFn).toHaveBeenCalled();
      const written = writeFn.mock.calls[0][1] as string;

      const startMarkerMatch = written.match(/echo "(__TABTIN_CMD_START_[^"]+)"/);
      expect(startMarkerMatch).not.toBeNull();
      const startMarker = startMarkerMatch![1];

      const endMarkerMatch = written.match(/echo "(__TABTIN_CMD_END_[a-f0-9]+_)\$\?/);
      expect(endMarkerMatch).not.toBeNull();
      const endMarkerPrefix = endMarkerMatch![1];

      session.outputBuffer.append(`${startMarker}\n`);
      session.outputBuffer.append('hello\n');
      session.outputBuffer.append(`${endMarkerPrefix}0_/tmp__\n`);
      runner.handleData(session.id);

      const result = await resultPromise;
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('hello');
      expect(result.cwd).toBe('/tmp');
      expect(result.backgrounded).toBe(false);
    });

    it('throws when session not found', () => {
      expect(() => runner.execute('nonexistent', 'ls')).toThrow('not found');
    });

    it('throws when session shell has exited', () => {
      const session = createSession(store);
      session.isRunning = false;
      expect(() => runner.execute(session.id, 'ls')).toThrow('shell has exited');
    });

    it('throws when a command is already pending', () => {
      const session = createSession(store);
      runner.execute(session.id, 'sleep 10', { blockUntilMs: 10000 });
      expect(() => runner.execute(session.id, 'ls')).toThrow('already has a running command');
    });

    it('returns backgrounded=true when blockUntilMs is 0', async () => {
      const session = createSession(store);
      const result = await runner.execute(session.id, 'sleep 100', { blockUntilMs: 0 });
      expect(result.backgrounded).toBe(true);
      expect(result.exitCode).toBeNull();
    });

    it('returns write-failure result when write returns false', async () => {
      writeFn.mockReturnValue(false);
      const session = createSession(store);
      const result = await runner.execute(session.id, 'echo hi', { blockUntilMs: 5000 });
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe('');
    });
  });

  // ── Auto-Respond ──

  describe('Auto-respond', () => {
    it('writes auto-respond when pattern matches output', async () => {
      vi.useFakeTimers();
      const session = createSession(store);
      runner.execute(session.id, 'npm install', {
        blockUntilMs: 10000,
        autoRespond: [{ pattern: 'proceed?', response: 'y\n' }],
      });

      session.outputBuffer.append('Do you want to proceed? (y/n) ');
      runner.handleData(session.id);

      vi.advanceTimersByTime(200);

      expect(writeFn).toHaveBeenCalledWith(session.id, 'y\n');
      vi.useRealTimers();
    });

    it('does not re-trigger after consume', async () => {
      vi.useFakeTimers();
      const session = createSession(store);
      runner.execute(session.id, 'cmd', {
        blockUntilMs: 10000,
        autoRespond: [{ pattern: 'confirm', response: 'yes\n' }],
      });

      session.outputBuffer.append('please confirm: ');
      runner.handleData(session.id);
      vi.advanceTimersByTime(200);

      const callCount = writeFn.mock.calls.filter(
        (c: unknown[]) => c[1] === 'yes\n',
      ).length;

      session.outputBuffer.append('please confirm again: ');
      runner.handleData(session.id);
      vi.advanceTimersByTime(200);

      const newCount = writeFn.mock.calls.filter(
        (c: unknown[]) => c[1] === 'yes\n',
      ).length;
      expect(newCount).toBe(callCount);
      vi.useRealTimers();
    });
  });

  // ── Session finalisation ──

  describe('finalizeSession', () => {
    it('marks session as not running and resolves pending command', () => {
      const session = createSession(store);
      let resolved: unknown = null;
      store.setPendingCommand(session.id, {
        nonce: 'n1',
        startMarker: 'SM',
        endMarkerPrefix: 'EM',
        startedAt: Date.now(),
        bufferStartCursor: 0,
        markerScanCursor: 0,
        resolve: (r) => { resolved = r; },
        timer: null,
        sessionId: session.id,
      });

      runner.finalizeSession(session, { exitCode: 42, removeSession: false, disposeWriteChannel: false });

      expect(session.isRunning).toBe(false);
      expect(session.terminationFinalized).toBe(true);
      expect(session.lastExitCode).toBe(42);
      expect(resolved).not.toBeNull();
      expect((resolved as any).exitCode).toBe(42);
    });

    it('is idempotent: second call with removeSession=true removes session', () => {
      const session = createSession(store);
      runner.finalizeSession(session, { exitCode: 0, removeSession: false, disposeWriteChannel: false });
      expect(store.hasSession(session.id)).toBe(true);

      runner.finalizeSession(session, { exitCode: 0, removeSession: true, disposeWriteChannel: false });
      expect(store.hasSession(session.id)).toBe(false);
    });
  });

  // ── handleExit ──

  describe('handleExit', () => {
    it('finalizes session and closes write channel', () => {
      const session = createSession(store);
      const closeFn = vi.fn();
      session.writeChannel = { close: closeFn, dispose: vi.fn(), enqueue: vi.fn(), isClosed: () => false, getQueuedBytes: () => 0, isClosedByError: () => false } as any;

      runner.handleExit(session, 0);
      expect(session.isRunning).toBe(false);
      expect(closeFn).toHaveBeenCalled();
    });
  });

  // ── Backgrounded watcher ──

  describe('Backgrounded watcher', () => {
    it('detects end marker for backgrounded command and updates session', async () => {
      const session = createSession(store);
      const result = await runner.execute(session.id, 'sleep 1', { blockUntilMs: 0 });
      expect(result.backgrounded).toBe(true);

      const written = writeFn.mock.calls[0][1] as string;
      const endMarkerMatch = written.match(/echo "(__TABTIN_CMD_END_[a-f0-9]+_)\$\?/);
      expect(endMarkerMatch).not.toBeNull();
      const endMarkerPrefix = endMarkerMatch![1];

      session.outputBuffer.append(`${endMarkerPrefix}0_/home/user__\n`);
      runner.handleData(session.id);

      expect(session.lastExitCode).toBe(0);
      expect(session.cwd).toBe('/home/user');
    });
  });
});

// ── Daemon-level structural tests ──

describe('DaemonPtyManager structure (W8-F1 refactor)', () => {
  const daemonPtySrc = (() => {
    try {
      const path = require('path');
      const fs = require('fs');
      return fs.readFileSync(
        path.resolve(__dirname, '..', '..', '..', '..', 'apps', 'tabtin-daemon', 'src', 'terminal', 'daemon-pty-manager.ts'),
        'utf-8',
      );
    } catch {
      return '';
    }
  })();

  it('daemon-pty-manager imports PtyCommandRunner from pty-core', () => {
    expect(daemonPtySrc).toContain('PtyCommandRunner');
  });

  it('daemon-pty-manager is ≤ 700 lines', () => {
    const lineCount = daemonPtySrc.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(700);
  });

  it('daemon-pty-manager does NOT contain checkPendingCommandMarker (moved to PtyCommandRunner)', () => {
    expect(daemonPtySrc).not.toMatch(/\bcheckPendingCommandMarker\s*\(/);
  });

  it('daemon-pty-manager does NOT contain checkAutoRespond (moved to PtyCommandRunner)', () => {
    expect(daemonPtySrc).not.toMatch(/\bcheckAutoRespond\s*\(/);
  });

  it('daemon-pty-manager does NOT contain checkBackgroundedWatchers (moved to PtyCommandRunner)', () => {
    expect(daemonPtySrc).not.toMatch(/\bcheckBackgroundedWatchers\s*\(/);
  });

  it('preserves all public API methods', () => {
    for (const method of [
      'spawn(', 'kill(', 'has(', 'getAllSessionIds(', 'getSessionCount(',
      'write(', 'getSessionOutput(', 'executeCommand(',
      'spawnAgentSession(', 'getOrSpawnAgentSession(', 'resolveThreadSession(',
      'releaseThreadSession(', 'getAllSessionsWithStatus(', 'cleanup(',
      'initialize(', 'isAvailable(',
    ]) {
      expect(daemonPtySrc).toContain(method);
    }
  });
});
