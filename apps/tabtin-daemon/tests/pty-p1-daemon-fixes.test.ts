/**
 * Tests for PTY-005, PTY-006, EF-04/SEC-002 fixes in DaemonPtyManager.
 *
 * These are static / structural tests that verify the code changes
 * without requiring a real node-pty process.
 *
 * Updated after W8-F1 refactor: marker pipeline, auto-respond, session
 * finalisation, and backgrounded-watcher logic now live in PtyCommandRunner
 * (from @tabtin/pty-core). DaemonPtyManager delegates via `this.commandRunner`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DAEMON_PTY_PATH = resolve(
  __dirname,
  '..',
  'src',
  'platform',
  'terminal',
  'daemon-pty-manager.ts',
);

const daemonPtySrc = readFileSync(DAEMON_PTY_PATH, 'utf-8');

describe('PTY-005 / SD-039: CLI environment variables — no SOCK/TOKEN injection', () => {
  it('does NOT import getCLIServerInfo (SD-039 Phase 1)', () => {
    expect(daemonPtySrc).not.toContain("import { getCLIServerInfo }");
  });

  it('does NOT inject TABTIN_SOCK via getCLIServerInfo (SD-039)', () => {
    expect(daemonPtySrc).not.toContain('cliEnv.TABTIN_SOCK = cliInfo.socketPath');
  });

  it('does NOT inject TABTIN_TOKEN via getCLIServerInfo (SD-039)', () => {
    expect(daemonPtySrc).not.toContain('cliEnv.TABTIN_TOKEN = cliInfo.token');
  });

  it('still injects TABTIN_SPACE_ID / TABTIN_AGENT_SPACE_ID', () => {
    expect(daemonPtySrc).toContain('cliEnv.TABTIN_SPACE_ID');
    expect(daemonPtySrc).toContain('cliEnv.TABTIN_AGENT_SPACE_ID');
  });

  it('injects TABTIN_AGENT for agent- sessions (P1-1)', () => {
    expect(daemonPtySrc).toContain('TABTIN_AGENT');
    expect(daemonPtySrc).toContain("startsWith('agent-')");
  });

  it('cliEnv is spread into the env passed to ptyHost.spawn', () => {
    const envBlock = daemonPtySrc.match(/env:\s*\{[^}]*\.\.\.cliEnv[^}]*\}/s);
    expect(envBlock).not.toBeNull();
  });

  it('contains SD-039 comment explaining the removal', () => {
    expect(daemonPtySrc).toContain('SD-039 Phase 1');
    expect(daemonPtySrc).toContain('server.json');
  });
});

describe('PTY-006: kill() double-dispose protection (via PtyCommandRunner)', () => {
  it('creates a PtyCommandRunner instance in the constructor', () => {
    expect(daemonPtySrc).toContain('new PtyCommandRunner(');
  });

  it('kill() delegates to commandRunner.finalizeSession', () => {
    // WP2 P1-A：kill 签名加了可选 signalOpts 参数（支持 SIGINT/SIGTERM/SIGKILL
    // 透传到 terminateTree），regex 用更宽松的"kill(...)... boolean { ... }"
    // 形态匹配，仍验证内部委托给 commandRunner.finalizeSession。
    const killMethod = daemonPtySrc.match(
      /kill\(\s*sessionId:\s*string,?[\s\S]*?\):\s*boolean\s*\{([\s\S]*?)\n  \}/,
    );
    expect(killMethod).not.toBeNull();
    expect(killMethod![1]).toContain('this.commandRunner.finalizeSession(session');
  });

  it('onExit callback delegates to commandRunner.handleExit', () => {
    expect(daemonPtySrc).toContain('this.commandRunner.handleExit(session');
  });

  it('spawn() initializes terminationFinalized to false', () => {
    expect(daemonPtySrc).toContain('terminationFinalized: false');
  });

  it('cleanup() uses commandRunner.finalizeSession for each session', () => {
    const cleanupBlock = daemonPtySrc.match(/cleanup\(\):\s*void\s*\{([\s\S]*?)\n  \}/);
    expect(cleanupBlock).not.toBeNull();
    expect(cleanupBlock![1]).toContain('this.commandRunner.finalizeSession(session');
  });
});

describe('EF-04/SEC-002: CommandValidator policy passthrough', () => {
  it('imports policy helpers from terminal-core', () => {
    expect(daemonPtySrc).toContain('getInteractiveTerminalPolicySupportError');
    expect(daemonPtySrc).toContain('evaluateTerminalPolicyDegradation');
  });

  it('executeCommand checks policy.route === blocked before delegating to commandRunner', () => {
    const execMethod = daemonPtySrc.match(
      /async executeCommand\([\s\S]*?this\.commandRunner\.execute\(/,
    );
    expect(execMethod).not.toBeNull();
    const beforeDelegate = execMethod![0];
    expect(beforeDelegate).toContain("policy?.route === 'blocked'");
  });

  it('throws Error when policy blocks (reject-by-throw pattern)', () => {
    const execMethod = daemonPtySrc.match(
      /async executeCommand\([\s\S]*?this\.commandRunner\.execute\(/,
    );
    expect(execMethod).not.toBeNull();
    const beforeDelegate = execMethod![0];
    expect(beforeDelegate).toContain('throw new Error(');
    expect(beforeDelegate).toContain('Command blocked by security policy');
  });

  it('delegates marker-based execution to commandRunner.execute', () => {
    expect(daemonPtySrc).toContain('return this.commandRunner.execute(sessionId, command');
  });
});
