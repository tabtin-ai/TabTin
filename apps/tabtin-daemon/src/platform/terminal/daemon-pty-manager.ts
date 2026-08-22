import type { Logger } from '../observability/logging/logger.js';
import {
  getInteractiveTerminalPolicySupportError,
  evaluateTerminalPolicyDegradation,
  evaluateLocalTerminalPolicy,
  executeDegraded,
} from '@tabtin/terminal-core';
import type {
  TerminalAutoRespondRule,
  TerminalExecutionContext,
  TerminalExecutionPolicy,
  DegradationDecision,
} from '@tabtin/terminal-core';
import {
  PtyOutputBuffer,
  PtyWriteChannel,
  PtyProcessTerminator,
  InProcessPtyHostClient,
  PtySessionStore,
  PtyCommandRunner,
  SyntheticPtyHostSession,
  cleanOutput,
  resolveCwd,
  resolveShell,
  detectShellType,
  sanitizeEnv,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_OUTPUT_BUFFER_BYTES,
} from '@tabtin/pty-core';
import type {
  ExecuteCommandResult,
  PtySession,
  PtyHostClient,
  PtyHostDisposable,
} from '@tabtin/pty-core';
import { collectProcessUsageTable } from './process-usage.js';

// WP2 P1-M：MAX_SESSIONS 从 10 提到 20 对齐 Electron PtyManager（apps/tabtin-electron/
// src/main/terminal/PtyManager.ts:72-74）。Daemon 端 D3 bridge 每次新 session +
// 30min stopped TTL 让连跑 10+ 命令必撞墙；用户视角等价性破裂。两端 limit 数字
// 现统一为 20（contract test 不验数字，只验 'agent session limit reached' 关键词）。
const MAX_SESSIONS = 20;
const MAX_SESSIONS_PER_SPACE = 3;
const IDLE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const AGENT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
/** Stopped (shell exited) sessions 保留时长，让 Agents / 4 件套人控在命令完成后仍能读输出。 */
const IDLE_TIMEOUT_STOPPED_MS = 30 * 60 * 1000;

export type { ExecuteCommandResult } from '@tabtin/pty-core';

export interface SessionStatusInfo {
  id: string;
  pid: number | null;
  cwd: string;
  isRunning: boolean;
  lastOutputAt: number;
  createdAt: number;
  lastExitCode: number | null;
  lastCommandCompletedAt: number | null;
  hasPendingCommand: boolean;
}

export interface SessionOutput {
  output: string;
  metadata: {
    pid: number | null;
    cwd: string;
    isRunning: boolean;
    lastOutputAt: number;
    lastExitCode: number | null;
    lastCommandCompletedAt: number | null;
    hasPendingCommand: boolean;
    // RT-4 R1：cursor 增量读支持字段（与 Electron PtyManager 对称）。
    nextCursor: number;
    totalBytes: number;
    overflowed: boolean;
  };
}

interface SpawnOptions { cwd?: string; shell?: string; spaceId?: string; env?: Record<string, string>; cols?: number; rows?: number; synthetic?: boolean }
interface ExecuteOptions { blockUntilMs?: number; workingDirectory?: string; env?: Record<string, string>; context?: TerminalExecutionContext; policy?: TerminalExecutionPolicy; autoRespond?: TerminalAutoRespondRule[]; killOnTimeout?: boolean; _degradationDecision?: DegradationDecision }

export class DaemonPtyManager {
  private readonly store = new PtySessionStore();
  private readonly terminator: PtyProcessTerminator;
  private readonly commandRunner: PtyCommandRunner;
  private readonly sessionDisposables = new Map<string, PtyHostDisposable[]>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private ptyHost: PtyHostClient | null = null;
  private workspaceRoot?: string;
  private envProvider?: () => Record<string, string>;

  /**
   * WP2: bridge contract test 等场景注入一个 mock `PtyHostClient`，跳过
   * 真实 node-pty 加载。生产代码（daemon.ts）调用时不传该 option，行为
   * 与原版完全一致（initialize() 仍 import('node-pty')）。
   *
   * 不传 = 走原 `import('node-pty')` + `new InProcessPtyHostClient()` 路径；
   * 传 = `initialize()` 直接使用注入实例，不做 dynamic import（也不报错）。
   */
  private readonly ptyHostOverride?: PtyHostClient;

  constructor(
    private readonly logger: Logger,
    options?: {
      workspaceRoot?: string;
      envProvider?: () => Record<string, string>;
      /** @internal 仅用于单测 / contract test 注入 mock host */
      ptyHost?: PtyHostClient;
    },
  ) {
    this.workspaceRoot = options?.workspaceRoot;
    this.envProvider = options?.envProvider;
    this.ptyHostOverride = options?.ptyHost;
    this.terminator = new PtyProcessTerminator({
      collectProcessTable: collectProcessUsageTable,
    });
    this.commandRunner = new PtyCommandRunner({
      store: this.store,
      write: (sid, data) => this.write(sid, data),
      logger: {
        debug: (msg: string) => this.logger.debug(msg),
        warn: (msg: string) => this.logger.warn(msg),
      },
      onNeedsRestart: (sessionId: string) => {
        const session = this.store.getSession(sessionId);
        if (!session?.needsRestart) return;
        this.restartSessionShell(sessionId);
      },
    });
  }

  async initialize(): Promise<boolean> {
    if (this.ptyHostOverride) {
      this.ptyHost = this.ptyHostOverride;
      this.startIdleCleanup();
      this.logger.info('[DaemonPty] using injected ptyHost (bridge contract test path)');
      return true;
    }
    try {
      // pty-core is ESM and cannot reliably resolve its fallback dynamic
      // require('node-pty') from a pnpm workspace. Resolve the app-owned native
      // dependency here, then inject it explicitly (same contract as Electron).
      const nodePty = await import('node-pty');
      this.ptyHost = new InProcessPtyHostClient(nodePty);
      this.startIdleCleanup();
      this.logger.info('[DaemonPty] node-pty loaded successfully');
      return true;
    } catch (err) {
      this.logger.warn(`[DaemonPty] node-pty not available: ${err}`);
      return false;
    }
  }

  /**
   * WP2 bridge 实现层用：拿 session 实例（attach 额外 onExit listener
   * 用于 bridge 触发 `agent-session-closed` 事件）。该方法只读，无副作用。
   */
  getSession(sessionId: string): PtySession | undefined {
    return this.store.getSession(sessionId);
  }

  isAvailable(): boolean {
    return this.ptyHost !== null;
  }

  // ── Session Management ──

  private spawnEnvironment(sessionId: string, options: SpawnOptions): Record<string, string> {
    const spaceId = options.spaceId || process.env.TABTIN_SPACE_ID || process.env.TABTIN_AGENT_SPACE_ID;
    const cliEnv: Record<string, string> = { ...sanitizeEnv(process.env), ...(this.envProvider?.() ?? {}), ...(options.env ? sanitizeEnv(options.env as NodeJS.ProcessEnv) : {}), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    if (spaceId) { cliEnv.TABTIN_SPACE_ID = spaceId; cliEnv.TABTIN_AGENT_SPACE_ID = spaceId; }
    if (sessionId.startsWith('agent-')) cliEnv.TABTIN_AGENT = '1';
    return cliEnv;
  }

  private attachSessionListeners(sessionId: string, session: PtySession): void {
    this.sessionDisposables.set(sessionId, [
      session.pty.onData((data: string) => { session.outputBuffer.append(data); session.lastOutputAt = Date.now(); this.commandRunner.handleData(sessionId); }),
      session.pty.onExit(({ exitCode }) => { this.commandRunner.handleExit(session, exitCode ?? null); this.logger.info(`[DaemonPty] Session exited: ${session.id}, exitCode=${exitCode}`); }),
    ]);
  }

  private canSpawn(sessionId: string, synthetic: boolean): boolean {
    if (!this.ptyHost && !synthetic) return false;
    if (this.store.hasSession(sessionId)) { this.logger.warn(`[DaemonPty] Session already exists: ${sessionId}`); return false; }
    if (this.store.getSessionCount() >= MAX_SESSIONS) { this.logger.warn(`[DaemonPty] Max sessions (${MAX_SESSIONS}) reached, cannot create: ${sessionId}`); return false; }
    return true;
  }

  spawn(sessionId: string, rawOptions?: SpawnOptions): boolean {
    const options = rawOptions || {};
    if (!this.canSpawn(sessionId, options.synthetic === true)) return false;

    const cwd = resolveCwd(options.cwd, this.workspaceRoot);
    const shell = options.shell || resolveShell();
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;

    let ptySession: ReturnType<PtyHostClient['spawn']> | SyntheticPtyHostSession | null = null;
    const cliEnv = this.spawnEnvironment(sessionId, options);
    try {
      // SD-039 Phase 1: 不再向 PTY 子进程注入 TABTIN_SOCK 和 TABTIN_TOKEN。
      // CLI 工具通过 ~/.tabtin/server.json 文件发现机制定位 socket（CB-02）。
      // 详见 support/strategy/2026-03-24-sd039-sock-assessment.md
      ptySession = options.synthetic
        ? new SyntheticPtyHostSession()
        : this.ptyHost!.spawn({
            shell,
            cwd,
            cols,
            rows,
            env: { ...cliEnv },
          });

      const writeChannel = options.synthetic
        ? undefined
        : new PtyWriteChannel(ptySession, {
            onWriteError: (error: unknown) => {
              this.logger.warn(`[DaemonPty] Write channel error for ${sessionId}: ${error}`);
            },
          });

      const now = Date.now();
      const session: PtySession = {
        id: sessionId,
        pty: ptySession,
        writeChannel,
        cwd,
        shellType: detectShellType(shell),
        createdAt: now,
        outputBuffer: new PtyOutputBuffer(MAX_OUTPUT_BUFFER_BYTES),
        lastOutputAt: now,
        pid: ptySession.pid,
        isRunning: true,
        lastExitCode: null,
        lastCommandCompletedAt: null,
        terminationFinalized: false,
      };

      this.store.createSession(session);

      if (!options.synthetic && ptySession.pid <= 0) {
        this.logger.error(`[DaemonPty] PTY spawn failed: pid=${ptySession.pid}, removing zombie session ${sessionId}`);
        this.store.deleteSession(sessionId);
        try { ptySession.kill(); } catch { /* best-effort */ }
        return false;
      }

      this.attachSessionListeners(sessionId, session);

      this.logger.info(
        `[DaemonPty] Session created: ${sessionId}, shell=${options.synthetic ? 'synthetic' : shell}, cwd=${cwd}, pid=${ptySession.pid}`,
      );
      return true;
    } catch (error) {
      this.logger.error(`[DaemonPty] Failed to create session: ${sessionId} — ${error}`);
      this.store.deleteSession(sessionId);
      this.sessionDisposables.delete(sessionId);
      try { ptySession?.kill(); } catch { /* best-effort */ }
      return false;
    }
  }

  kill(
    sessionId: string,
    signalOpts?: {
      gracefulSignal?: NodeJS.Signals;
      forceSignal?: NodeJS.Signals;
      forceAfterMs?: number;
    },
  ): boolean {
    const session = this.store.getSession(sessionId);
    if (!session) return false;

    const pid = session.pid;

    this.commandRunner.finalizeSession(session, {
      exitCode: null,
      removeSession: false,
      disposeWriteChannel: true,
    });

    try {
      // node-pty kill 接受 signal 参数；undefined → SIGTERM 默认。
      session.pty.kill(signalOpts?.gracefulSignal);
    } catch (err) {
      this.logger.warn(`[DaemonPty] Kill failed for ${sessionId}: ${err}`);
    }

    if (pid) {
      // P1-A signal 透传：调用方覆盖 graceful/force 策略。
      this.terminator.terminateTree(pid, {
        gracefulSignal: signalOpts?.gracefulSignal,
        forceSignal: signalOpts?.forceSignal,
        forceAfterMs: signalOpts?.forceAfterMs,
        guard: () => !this.store.getAllSessions().some((s) => s.pid === pid && s.isRunning),
      });
    }

    this.store.deleteSession(sessionId);
    this.disposeSessionListeners(sessionId);

    this.logger.info(`[DaemonPty] Session killed: ${sessionId}`);
    return true;
  }

  private disposeSessionListeners(sessionId: string): void {
    const disposables = this.sessionDisposables.get(sessionId);
    if (disposables) {
      for (const d of disposables) d.dispose();
      this.sessionDisposables.delete(sessionId);
    }
  }

  has(sessionId: string): boolean { return this.store.hasSession(sessionId); }
  getAllSessionIds(): string[] { return this.store.getAllSessionIds(); }
  getSessionCount(): number { return this.store.getSessionCount(); }

  // ── Data Read/Write ──

  write(sessionId: string, data: string): boolean {
    const session = this.store.getSession(sessionId);
    if (!session || !session.isRunning) return false;
    if (session.writeChannel && !session.writeChannel.isClosed()) return session.writeChannel.enqueue(data);
    if (!session.writeChannel) return false;
    try { session.pty.write(data); return true; } catch (err) {
      this.logger.warn(`[DaemonPty] Write failed for ${sessionId}: ${err}`);
      return false;
    }
  }

  getSessionOutput(sessionId: string, options?: { tail?: number; sinceCursor?: number }): SessionOutput | null {
    const session = this.store.getSession(sessionId);
    if (!session) return null;
    const buf = session.outputBuffer;
    // RT-4 R1：cursor 增量优先（readFromCursor 只读新增 chunk）；其次 tail；否则全量。
    let rawOutput: string;
    if (options?.sinceCursor != null) {
      rawOutput = buf.readFromCursor(options.sinceCursor);
    } else if (options?.tail) {
      rawOutput = buf.readTail(options.tail);
    } else {
      rawOutput = buf.readAll();
    }
    return {
      output: cleanOutput(rawOutput),
      metadata: {
        pid: session.pid, cwd: session.cwd, isRunning: session.isRunning,
        lastOutputAt: session.lastOutputAt, lastExitCode: session.lastExitCode,
        lastCommandCompletedAt: session.lastCommandCompletedAt,
        hasPendingCommand: this.store.hasPendingCommand(session.id),
        nextCursor: buf.createCursor(),
        totalBytes: buf.getTotalBytes(),
        overflowed: buf.hasOverflowed(),
      },
    };
  }

  appendAgentTranscriptData(sessionId: string, data: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    session.outputBuffer.append(data);
    session.lastOutputAt = Date.now();
  }

  markAgentTranscriptRunning(sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    session.isRunning = true;
  }

  markAgentTranscriptCompleted(
    sessionId: string,
    result: { cwd?: string; exitCode: number | null },
  ): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    if (result.cwd) session.cwd = result.cwd;
    session.lastExitCode = result.exitCode;
    session.lastCommandCompletedAt = Date.now();
    session.isRunning = false;

    // run_terminal_command_后台执行重构_2026-05-18 §5.1：
    // 与 Electron PtyManager 同步——synthetic agent transcript 不走 onExit，
    // 必须显式延迟释放 store 配额，否则 LLM 累计 20 次 run_terminal_command
    // 就撞 limit（dogfood 2026-05-18 session 16dd07d8 已撞过）。
    // 5 秒延迟让用户能看到最后输出再回收。
    setTimeout(() => {
      if (this.store.hasSession(sessionId)) {
        this.logger.info(`[DaemonPty] removing completed agent transcript: ${sessionId}`);
        this.disposeSessionListeners(sessionId);
        this.store.deleteSession(sessionId);
      }
    }, 5_000);
  }

  // ── needsRestart: auto-recovery after unresponsive commands ──

  /**
   * EF5-P1: Restart a session's shell in-place after a command could not be
   * stopped via Ctrl+C. Mirrors Electron PtyManager.restartSessionShell.
   */
  private restartSessionShell(sessionId: string): boolean {
    const session = this.store.getSession(sessionId);
    if (!session) return false;
    if (!this.ptyHost) return false;

    this.logger.info(`[DaemonPty] ♻️ Restarting session shell: ${sessionId}`);
    session.needsRestart = false;

    this.disposeSessionListeners(sessionId);
    const oldPid = session.pid;
    try { session.pty.kill(); } catch (err) {
      this.logger.warn(`[DaemonPty] restart: kill old PTY failed: ${sessionId} — ${err}`);
    }
    if (oldPid) {
      this.terminator.terminateTree(oldPid, {
        forceAfterMs: 100,
        guard: () => !this.store.getAllSessions().some((s) => s.pid === oldPid && s.isRunning),
      });
    }
    session.writeChannel?.dispose();

    this.resolvePendingForRestart(sessionId, session);
    this.store.deleteBackgroundedWatchers(sessionId);

    const shell = resolveShell();
    // SD-039 Phase 1: 不再向 PTY 子进程注入 TABTIN_SOCK 和 TABTIN_TOKEN。
    // CLI 工具通过 ~/.tabtin/server.json 文件发现机制定位 socket（CB-02）。
    // 详见 support/strategy/2026-03-24-sd039-sock-assessment.md

    session.outputBuffer = new PtyOutputBuffer(MAX_OUTPUT_BUFFER_BYTES);

    try {
      const newPty = this.ptyHost.spawn({
        shell,
        cwd: session.cwd,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        env: {
          ...this.spawnEnvironment(sessionId, {}),
        },
      });

      session.pty = newPty;
      session.pid = newPty.pid;
      session.isRunning = true;
      session.shellType = detectShellType(shell);
      session.terminationFinalized = false;
      session.lastExitCode = null;

      session.writeChannel = new PtyWriteChannel(newPty, {
        onWriteError: (error: unknown) => {
          this.logger.warn(`[DaemonPty] Write channel error for ${sessionId}: ${error}`);
        },
      });

      this.sessionDisposables.set(sessionId, [
        newPty.onData((data: string) => {
          session.outputBuffer.append(data);
          session.lastOutputAt = Date.now();
          this.commandRunner.handleData(sessionId);
        }),
        newPty.onExit(({ exitCode }) => {
          this.commandRunner.handleExit(session, exitCode ?? null);
          this.logger.info(`[DaemonPty] Session exited: ${session.id}, exitCode=${exitCode}`);
        }),
      ]);

      this.logger.info(`[DaemonPty] ✅ Session restarted: ${sessionId}, newPid=${newPty.pid}`);
      return true;
    } catch (error) {
      this.logger.error(`[DaemonPty] ❌ Session restart failed: ${sessionId} — ${error}`);
      session.isRunning = false;
      session.needsRestart = true;
      return false;
    }
  }

  private resolvePendingForRestart(sessionId: string, session: PtySession): void {
    const pending = this.store.deletePendingCommand(sessionId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.autoRespondTimers) for (const timer of pending.autoRespondTimers) clearTimeout(timer);
    pending.resolve({ output: '', exitCode: null, cwd: session.cwd, backgrounded: false, timedOut: false, durationMs: Date.now() - pending.startedAt, sessionId });
  }

  private terminalDegradation(command: string, options?: ExecuteOptions): DegradationDecision | undefined {
    this.validateTerminalPolicy(command, options?.policy);
    if (options?._degradationDecision?.canDegrade) return options._degradationDecision;
    const unsupported = getInteractiveTerminalPolicySupportError(options?.policy);
    if (!unsupported) return undefined;
    const degradation = evaluateTerminalPolicyDegradation(options?.policy);
    if (degradation?.canDegrade) return degradation;
    throw new Error(unsupported);
  }

  private validateTerminalPolicy(command: string, policy?: TerminalExecutionPolicy): void {
    if (!policy) return;
    const decision = evaluateLocalTerminalPolicy(command, policy);
    if (decision.blocked) throw new Error(`Command blocked by local terminal policy: ${decision.denyReason || 'not allowed'}`);
  }

  private commandExecutionOptions(session: PtySession, options?: ExecuteOptions) {
    return { blockUntilMs: options?.blockUntilMs, env: { ...options?.context?.env, ...options?.env }, workingDirectory: options?.workingDirectory ?? options?.context?.workingDirectory, shellType: session.shellType ?? detectShellType(resolveShell()), autoRespond: options?.autoRespond, killOnTimeout: options?.killOnTimeout ?? true };
  }

  private ensureSessionRestarted(sessionId: string, session: PtySession): void {
    if (!session.needsRestart) return;
    if (!this.restartSessionShell(sessionId)) throw new Error(`Session ${sessionId} requires restart after an unresponsive command, but restart failed`);
  }

  // ── Command Execution ──

  async executeCommand(
    sessionId: string,
    command: string,
    options?: ExecuteOptions,
  ): Promise<ExecuteCommandResult> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const policy = options?.policy;
    if (policy?.route === 'blocked') throw new Error(`Command blocked by security policy: ${policy.denyReason || 'execution not allowed by current sandbox policy'}`);

    const degradation = this.terminalDegradation(command, options);
    if (degradation) return this.executeDegradedImpl(session, command, options, degradation);

    // EF5-P1: Pre-flight check — if a previous timeout left the session in
    // needsRestart state, restart the shell before executing the new command.
    this.ensureSessionRestarted(sessionId, session);

    return this.commandRunner.execute(sessionId, command, this.commandExecutionOptions(session, options));
  }

  /**
   * 降级执行路径：当 PTY 不支持请求的安全策略时（如 route=sandbox、networkMode=blocked），
   * 降级到 CommandExecutor spawn + OS sandbox 执行。
   * 核心逻辑已提取到 @tabtin/terminal-core 的 executeDegraded。
   */
  private async executeDegradedImpl(
    session: PtySession,
    command: string,
    options: {
      blockUntilMs?: number;
      workingDirectory?: string;
      env?: Record<string, string>;
      context?: TerminalExecutionContext;
      policy?: TerminalExecutionPolicy;
    } | undefined,
    degradation: DegradationDecision,
  ): Promise<ExecuteCommandResult> {
    if (this.store.hasPendingCommand(session.id)) {
      throw new Error(`Session ${session.id} already has a pending command`);
    }

    this.logger.info(
      `[DaemonPty] Degrading to CommandExecutor (spawn+sandbox): ${degradation.reason} — ${command.slice(0, 120)}`,
    );

    const cwd = options?.workingDirectory
      ?? options?.context?.workingDirectory
      ?? session.cwd;

    const timeoutMs = options?.blockUntilMs != null && options.blockUntilMs > 0
      ? options.blockUntilMs
      : undefined;

    const result = await executeDegraded({
      command,
      cwd,
      degradation,
      threadId: options?.context?.threadId,
      timeout: timeoutMs,
      onOutput: (data) => {
        session.outputBuffer.append(data);
        session.lastOutputAt = Date.now();
        this.commandRunner.handleData(session.id);
      },
    });

    if (result.interactiveBlocked) {
      return {
        output: '',
        exitCode: -1,
        cwd,
        backgrounded: false,
        timedOut: false,
        durationMs: 0,
        sessionId: session.id,
        interactiveBlocked: true,
        interactiveReason: result.interactiveReason,
        matchedCommand: result.matchedCommand,
      };
    }

    return {
      output: [result.stdout, result.stderr].filter(Boolean).join('\n[stderr]\n'),
      exitCode: result.exitCode,
      cwd: result.cwd,
      backgrounded: false,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      sessionId: session.id,
    };
  }

  // ── Thread → Session Mapping ──

  spawnAgentSession(agentSpaceId: string, options?: { cwd?: string; threadId?: string }): string | null {
    const spaceSessionCount = this.store.getAllSessions()
      .filter(s => s.spaceId === agentSpaceId && s.isRunning)
      .length;
    if (spaceSessionCount >= MAX_SESSIONS_PER_SPACE) {
      this.logger.warn(`[DaemonPty] Max sessions per space (${MAX_SESSIONS_PER_SPACE}) reached for ${agentSpaceId}`);
      return null;
    }

    const sessionId = `agent-${agentSpaceId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (!this.spawn(sessionId, { cwd: options?.cwd })) return null;
    const session = this.store.getSession(sessionId);
    if (session) session.spaceId = agentSpaceId;
    if (options?.threadId) this.store.setThreadSession(options.threadId, sessionId);
    return sessionId;
  }

  getOrSpawnAgentSession(threadId: string, agentSpaceId: string, options?: { cwd?: string }): string | null {
    const existing = this.store.getThreadSession(threadId);
    if (existing) {
      const s = this.store.getSession(existing);
      if (s && s.isRunning) return existing;
      this.store.deleteThreadSession(threadId);
    }
    return this.spawnAgentSession(agentSpaceId, { cwd: options?.cwd, threadId });
  }

  resolveThreadSession(threadId: string): string | null {
    const sid = this.store.getThreadSession(threadId);
    if (!sid) return null;
    const s = this.store.getSession(sid);
    return s && s.isRunning ? sid : null;
  }

  releaseThreadSession(threadId: string): void { this.store.deleteThreadSession(threadId); }

  getAllSessionsWithStatus(agentSpaceId?: string): SessionStatusInfo[] {
    return this.store.getAllSessions()
      .filter((s) => !agentSpaceId || s.spaceId === agentSpaceId)
      .map((s) => ({
        id: s.id, pid: s.pid, cwd: s.cwd, isRunning: s.isRunning,
        lastOutputAt: s.lastOutputAt, createdAt: s.createdAt,
        lastExitCode: s.lastExitCode, lastCommandCompletedAt: s.lastCommandCompletedAt,
        hasPendingCommand: this.store.hasPendingCommand(s.id),
      }));
  }

  // ── Cleanup ──

  cleanup(): void {
    this.logger.info(`[DaemonPty] Cleaning up ${this.store.getSessionCount()} session(s)`);
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    for (const [, session] of this.store.getSessionEntries()) {
      this.commandRunner.finalizeSession(session, { exitCode: null, removeSession: false, disposeWriteChannel: true });
      try { session.pty.kill(); } catch { /* best-effort */ }
      if (session.pid) this.terminator.terminateTree(session.pid, { gracefulSignal: 'SIGKILL' });
    }
    this.store.clear();
    for (const disposables of this.sessionDisposables.values()) {
      for (const d of disposables) d.dispose();
    }
    this.sessionDisposables.clear();
  }

  private startIdleCleanup(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => this.evictIdleSessions(), IDLE_CHECK_INTERVAL_MS);
    this.idleTimer.unref();
  }

  private evictIdleSessions(): void {
    const now = Date.now();
    for (const s of this.store.getAllSessions()) {
      const idleMs = now - s.lastOutputAt;
      const expired = !s.isRunning ? idleMs > IDLE_TIMEOUT_STOPPED_MS : idleMs > AGENT_IDLE_TIMEOUT_MS;
      if (expired) { this.logger.info(`[DaemonPty] Evicting idle session: ${s.id}`); this.kill(s.id); }
    }

    // E6: 静默 session 的 backgroundedWatcher 过期清理
    // 正常流程中 watcher 过期检查仅在 PTY 数据事件（handleData）中触发，
    // 如果后台命令完成后 session 不再产生输出，过期 watcher 永远不会被清理。
    // 此处主动触发一次 handleData，内部 checkBackgroundedWatchers 会淘汰超龄 watcher。
    for (const sessionId of this.store.getAllSessionIds()) {
      this.commandRunner.handleData(sessionId);
    }
  }
}
