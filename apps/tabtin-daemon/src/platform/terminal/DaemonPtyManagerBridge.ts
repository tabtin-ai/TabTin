/**
 * DaemonPtyManagerBridge — WP2 Daemon 端 PtyManagerBridge 实现。
 *
 * **业务定位**：让 Daemon 模式下本地 LLM 走 ShellCap 跑命令时，与 Electron
 * 端行为等价（contract test 强制一致）。命令本身由一次性 child process 执行；
 * DaemonPtyManager 只创建 transcript session。Daemon 无 GUI，事件订阅消费者
 * 主要是结构化日志（运维 grep `agent_session_created`）+ 未来 CLI 监控。
 *
 * **关键设计取舍**（与 ElectronPtyManagerBridge 严格对齐 — 双源避免漂移）：
 *   - **不走 `spawnAgentSession` 也不走 `getOrSpawnAgentSession`**：与
 *     Electron 同款隔离 4 件套人控路径（agent-bridge.ts L559-562）。
 *   - **自己维护 subscribers Map**：Daemon `DaemonPtyManager` 不 extends
 *     EventEmitter，没有现成事件总线；bridge 自建内存订阅表（约 30 行）。
 *   - **emit 同时落 logger.info 结构化日志**：`{ event: 'agent_session_created', ... }`
 *     便于运维 grep + contract test 验证（agent-bridge.ts L412-415 / 总控 L403）。
 *   - **持续写盘走共享 helper `AgentOutputTail`**：与 Electron 同源。
 *   - **subscribe 边界 + threadId null 映射**严格按 agent-bridge.ts L444-449 / L652-668。
 *
 * **跟 4 件套的隔离性**：与 Electron 端同款约束，bridge 写到 `session.agentMeta`
 * 字段（pty-core PtySession 已扩展），4 件套不读该字段。
 *
 * **emit 时序**：bridge 在启动 child process 之前完成 emit
 * （agent-bridge.ts L419-421 / L559-564 / L584-589）。
 */

import {
  AgentOutputTail,
  AgentPromptStallWatchdog,
  createAgentProgressDispatcher,
  DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
  ManagedTaskStore,
  resolveNotificationRouteThreadId,
  NotificationQueue,
  runAgentOutputTailGC,
  spawnAgentShellProcess,
  tabtinAgentTaskStatusPath,
  type AgentCommandRequest,
  type AgentCommandResult,
  type AgentShellProcessHandle,
  type AgentShellProcessResult,
  type AgentKillSignal,
  type AgentReadOptions,
  type AgentReadResult,
  type AgentSessionCloseReason,
  type AgentSessionClosed,
  type AgentSessionCreated,
  type AgentSessionEventHandler,
  type AgentSessionEventMap,
  type AgentSessionEventName,
  type AgentSessionUnsubscribe,
  type AgentSpawnDetachedResult,
  type BackgroundTaskCompletedPayload,
  type ExitedBy,
  type KilledReason,
  type ManagedTaskOwner,
  type NotificationEnvelope,
  type NotificationPriority,
  type PtyManagerBridge,
} from '@tabtin/terminal-core';
import { cleanOutput, type PtyHostDisposable, type PtySession } from '@tabtin/pty-core';
import type { DaemonPtyManager } from './daemon-pty-manager.js';
import type { Logger } from '../observability/logging/logger.js';

/**
 * owner 固化（终端假运行根治 Layer 1 / 治 F1）：spawn 时解析当前命令归属
 * `{userId, organizationId}` 的回调。Daemon 单 owner——由 daemon.ts 注入
 * `() => config.{user_id, organization_id}`。缺失（config 未含 user_id / organization_id）
 * → 返回 undefined，终态投递回落 gateway 默认 owner（不劣化于固化前）。
 */
export type ManagedTaskOwnerResolver = () => ManagedTaskOwner | undefined;

/**
 * Daemon 端 per-space limit（与 daemon-pty-manager.ts L38 `MAX_SESSIONS_PER_SPACE = 3`
 * 字面一致，两端 limit **可不一致**——contract test 不验数字，只验关键词
 * `agent session limit reached`（L571-575）。
 */
const MAX_AGENT_SESSIONS_PER_SPACE = 3;

/**
 * P1-D 幂等：bridge 见过但已 cleanup 的 sessionId 保留在 LRU Map 里 5min，
 * 后续 killAgentSession / readAgentSessionOutput 命中时 no-op resolve 而不
 * throw `not found`（agent-bridge.ts L625 / L610 硬契约）。
 */
const RECENTLY_ENDED_TTL_MS = 5 * 60 * 1000;
const RECENTLY_ENDED_MAX_SIZE = 256;

interface AgentSessionRecord {
  sessionId: string;
  spaceId: string;
  agentMeta: AgentCommandRequest['agentMeta'];
  tail: AgentOutputTail | null;
  process: AgentShellProcessHandle | null;
  processRunning: boolean;
  watchdog: AgentPromptStallWatchdog | null;
  mode: 'foreground' | 'detached';
  /** detached 模式下 attach 的额外 onData / onExit disposable */
  extraDisposables: PtyHostDisposable[];
  /**
   * run-terminal-command_后台执行重构_2026-05-18 §4.2 + 2026-05-18 review P0-4/P1-3：
   * 用户主动 kill / GC hard_timeout / kill_tool 时记下 reason，与 PRD KilledReason 枚举对齐。
   */
  pendingKillReason?: 'kill_tool' | 'user_interrupt' | 'hard_timeout';
}

function archivedAgentOutput(task: NonNullable<ReturnType<ManagedTaskStore['get']>>): AgentReadResult {
  return { output: '', outputBytes: task.stdout_byte_count, isRunning: task.status === 'running', exitCode: task.exit_code ?? null, cwd: task.cwd, lastOutputAt: task.last_output_at, truncated: false, exitedBy: task.exited_by, killedReason: task.killed_reason, outputFilePath: task.output_file_path || undefined, pid: task.pid };
}

function incrementalAgentOutput(output: string, opts?: AgentReadOptions): string {
  if (opts?.sinceCursor != null) return output;
  const offset = opts?.sinceByteOffset ?? 0;
  const bytes = Buffer.byteLength(output, 'utf-8');
  if (offset >= bytes) return '';
  if (offset <= 0) return output;
  return Buffer.from(output, 'utf-8').subarray(offset).toString('utf-8');
}

function agentExitedBy(killReason: KilledReason | undefined, exitCode: number | null): ExitedBy {
  if (killReason) return 'signal';
  return exitCode === 126 || exitCode === 127 ? 'exec_failure' : 'normal_exit';
}

export class DaemonPtyManagerBridge implements PtyManagerBridge {
  private readonly subscribers: {
    [K in AgentSessionEventName]: Array<AgentSessionEventHandler<K>>;
  } = {
    'agent-session-created': [],
    'agent-session-closed': [],
  };
  private readonly agentSessions = new Map<string, AgentSessionRecord>();
  /** P1-D 幂等：sessionId → endedAt（ms），TTL evict。 */
  private readonly recentlyEndedSessions = new Map<string, number>();
  /**
   * Daemon 端 close reason 区分（产品 R1 P1-1）：bridge.killAgentSession 触发的
   * kill 标记 'kill'，未标记走 'exit' 默认。`evictIdleSessions` 路径目前不经
   * bridge —— 只能 fallback 到 'exit'，准确度不完美但运维 grep 仍能定位事件。
   */
  private readonly pendingCloseReasons = new Map<string, AgentSessionCloseReason>();
  /**
   * run-terminal-command_后台执行重构_2026-05-18 §4.2：ManagedTask store。
   * Daemon 进程独立持有一份内存 store（不跨 Electron 共享 —— PRD §4.2.4 跨进程独立 +
   * session_id 前缀路由）。GC 随 bridge 启停。
   */
  private readonly managedTaskStore: ManagedTaskStore;

  /**
   * 2026-05-23 push 通知重构 commit 2/3：notificationQueue 用来在后台命令退出时
   * push 通知激活父 Agent 下一轮 turn。
   *
   * **持有方式**（跟 ManagedTaskStore 同款）：bridge 内部默认 new 一个，
   * Daemon 进程独立持有自己的 queue 实例（不跨 Electron 共享 — PRD §6.1 D8
   * "两端各持一份独立 store"）。GC 默认随 bridge 启动；dispose 时停。
   *
   * **commit 3 host 接入路径**：DaemonAgentHost 通过 bridge.getNotificationQueue()
   * 拿 queue → subscribe(listener) 注册 idle drain 触发器。详见 PRD §6.3 + §6.7。
   */
  private readonly notificationQueue: NotificationQueue;

  /**
   * owner 固化（终端假运行根治 Layer 1 / 治 F1）：spawn 时解析命令归属的回调。
   * daemon.ts 注入 `() => config.{user_id, organization_id}`。缺省 undefined → record
   * 不带 owner，终态投递回落 gateway 默认 owner。
   */
  private readonly ownerResolver?: ManagedTaskOwnerResolver;

  constructor(
    private readonly ptyManager: DaemonPtyManager,
    private readonly logger: Logger,
    options: {
      managedTaskStore?: ManagedTaskStore;
      notificationQueue?: NotificationQueue;
      ownerResolver?: ManagedTaskOwnerResolver;
    } = {},
  ) {
    this.ownerResolver = options.ownerResolver;
    this.notificationQueue = options.notificationQueue ?? new NotificationQueue({
      log: (msg, err) => this.logger.warn(`[NotificationQueue] ${msg}: ${err ?? ''}`),
    });
    this.notificationQueue.startGc();
    this.managedTaskStore =
      options.managedTaskStore ??
      new ManagedTaskStore({
        hardTimeoutHandlers: {
          // run-terminal-command_后台执行重构_2026-05-18 §6.2 / §6.6：6h warning。
          // Daemon 模式下用 logger.warn 让运维 grep；12h SIGTERM 走 onKill。
          onWarning: (record) => {
            this.logger.warn(
              `[DaemonPtyManagerBridge] hard_timeout warning: session ${record.session_id} ` +
                `(command: ${record.command.slice(0, 80)}) has been running for >6h. ` +
                `Will SIGTERM at 12h if still running.`,
            );
          },
          onKill: async (sessionId: string) => {
            // 2026-05-18 review P1-3：hard_timeout 兜底必须标 'hard_timeout'。
            const ar = this.agentSessions.get(sessionId);
            if (ar) ar.pendingKillReason = 'hard_timeout';
            try {
              await this.killAgentSession(sessionId, 'SIGTERM');
            } catch {
              // session 已没了，no-op
            }
          },
        },
        log: (msg, err) => this.logger.warn(`[ManagedTaskStore] ${msg}: ${err ?? ''}`),
      });
    this.managedTaskStore.startGc();
  }

  /**
   * 调用方手动 dispose：关所有 tail fd、移除 transcript listener、**主动 kill 所有
   * 仍 running 的子进程**。
   *
   * 2026-05-18 review P0-8 上线必修：Daemon spawn 用 detached: false 后子进程
   * 不再是新 session leader。但 macOS 没有 Linux `PR_SET_PDEATHSIG` 等价机制
   * 让 Daemon 一死子进程自动收 SIGHUP——只能在 dispose 时主动清。
   *
   * **典型触发场景**：
   *   - Daemon 进程正常退出（systemd / launchd 重启 / 用户 quit）
   *   - 用户在客户端切换 host / 重启 Daemon 配置
   *
   * **kill -9 / crash 场景**仍可能漏掉**：那时 dispose 不会被调用，子进程
   * 没了父进程后会被 OS 接管但因为 detached: false 不是 session leader 也会随
   * shell exit。最坏情况：tab-detached + immediate parent death，OS 仍会清掉。
   *
   * **不**清理 agent-tasks 磁盘文件（让用户后续仍能 read_file 历史 log）。
   */
  async dispose(): Promise<void> {
    // 主动 kill 所有 still-running session 的子进程
    for (const session of this.agentSessions.values()) {
      if (session.processRunning && session.process) {
        try {
          session.process.kill('SIGTERM');
        } catch {
          // best-effort
        }
        session.processRunning = false;
      }
    }
    for (const sid of [...this.agentSessions.keys()]) {
      this.cleanupSession(sid);
    }
    this.subscribers['agent-session-created'].length = 0;
    this.subscribers['agent-session-closed'].length = 0;
    this.managedTaskStore.stopGc();
    this.notificationQueue.stopGc();
  }

  /**
   * 暴露 ManagedTaskStore 供 ShellCap / 测试访问。与 Electron bridge 同款 API。
   */
  getManagedTaskStore(): ManagedTaskStore {
    return this.managedTaskStore;
  }

  /**
   * UI「转入后台」：在 ManagedTaskStore 上登记 detach 请求，由 ShellCap poll 消费。
   * 不杀进程——与 wait_ms 超时转后台同一出口。
   */
  requestDetachAgentSession(sessionId: string): boolean {
    return this.managedTaskStore.requestDetach(sessionId);
  }

  /**
   * 用户点「停止」时设置显式 kill 信号，让前台 ShellCap poll 循环确定性退出
   * 等待（与 requestDetachAgentSession 对称）。实际杀进程仍由 killAgentSession
   * 负责——本方法只保证 poll 不再空等竞态窗口。
   */
  requestKillAgentSession(sessionId: string): boolean {
    return this.managedTaskStore.requestKill(sessionId);
  }

  /**
   * 2026-05-23 push 通知重构 commit 3：暴露 NotificationQueue 给 host 接入。
   * 与 Electron bridge `getNotificationQueue` 同款 API。详见 PRD §6.3 + §6.7。
   */
  getNotificationQueue(): NotificationQueue {
    return this.notificationQueue;
  }

  // ==================== PtyManagerBridge 接口 ====================

  async executeAgentCommand(req: AgentCommandRequest): Promise<AgentCommandResult> {
    if (req.signal?.aborted) {
      throw new AbortError(`executeAgentCommand: signal already aborted`);
    }

    const sessionId = this.spawnAgentBridgeSession(req, 'foreground');
    const cwdAtSpawn = this.requireSession(sessionId).cwd;

    // P1-J 窗口期防御：spawn 后立即再检查 signal 是否已 aborted。
    if (req.signal?.aborted) {
      this.ptyManager.kill(sessionId);
      throw new AbortError(`executeAgentCommand: signal aborted during spawn`);
    }

    const timeoutMs = req.timeoutMs ?? DEFAULT_AGENT_COMMAND_TIMEOUT_MS;
    const handle = this.startAgentProcess(req, sessionId, {
      timeoutMs,
      enforceTimeout: true,
    });
    const processResult = await handle.result;

    const stdout = cleanOutput(processResult.output ?? '');
    const cwdAfter = processResult.cwd ?? cwdAtSpawn;
    const durationMs = processResult.durationMs;

    let status: AgentCommandResult['status'];
    if (processResult.timedOut) {
      status = 'timeout';
    } else if (processResult.exitCode === null) {
      status = 'error';
    } else {
      status = 'ok';
    }

    const result: AgentCommandResult = {
      status,
      exitCode: processResult.exitCode,
      stdout,
      stderr: '',
      durationMs,
      truncated: processResult.truncated === true,
      outputBytes: processResult.outputBytes,
      cwd: cwdAfter,
      sessionId,
      ...(processResult.outputFilePath
        ? {
            outputFilePath: processResult.outputFilePath,
            ...(typeof processResult.outputFileSize === 'number'
              ? { outputFileSize: processResult.outputFileSize }
              : {}),
          }
        : {}),
    };

    return result;
  }

  async spawnAgentSessionDetached(req: AgentCommandRequest): Promise<AgentSpawnDetachedResult> {
    if (req.signal?.aborted) {
      throw new AbortError(`spawnAgentSessionDetached: signal already aborted`);
    }

    const sessionId = this.spawnAgentBridgeSession(req, 'detached');
    const record = this.requireAgentRecord(sessionId);

    // P1-J 窗口期防御。
    if (req.signal?.aborted) {
      await this.killAgentSession(sessionId, 'SIGTERM').catch(() => {});
      throw new AbortError(`spawnAgentSessionDetached: signal aborted during spawn`);
    }

    // run-terminal-command_后台执行重构_2026-05-18 §4.2：创建 ManagedTask record。
    // 2026-05-18 review P0-2：透传 req.timeoutMs 作为 per-record hard_timeout_ms。
    // owner 固化（终端假运行根治 Layer 1 / 治 F1）：spawn 时焊死命令归属。
    // Daemon 单 owner 来自 config.{user_id, organization_id}（注入的 ownerResolver）。
    const owner = this.resolveManagedTaskOwner();

    // Layer 2 退出码 sidecar（终端假运行根治 v3 / 治 F9）：与 output_file 同目录分配
    // `<session>.status`，传给 spawn 让 shell 进程退出前 echo $? 落盘；落进 record
    // 持久化字段，daemon 崩溃 / kill -9 后启动对账据它恢复真实退出码。
    const statusFilePath = tabtinAgentTaskStatusPath(sessionId);

    this.managedTaskStore.createRecord({
      session_id: sessionId,
      command: req.command,
      // LLM 命令意图摘要——透传到 record，后台完成通知优先用它向用户展示（与 Electron 对称）。
      description: req.agentMeta.description ?? undefined,
      cwd: req.cwd ?? this.requireSession(sessionId).cwd,
      env: req.env,
      spaceId: req.agentMeta.spaceId,
      threadId: req.agentMeta.threadId,
      notificationThreadId: req.agentMeta.notificationThreadId,
      toolUseId: req.agentMeta.toolUseId,
      owner,
      output_file_path: record.tail?.getFilePath() ?? '',
      statusfile_path: statusFilePath,
      hard_timeout_ms: req.timeoutMs,
      sync_notification_claim: req.syncNotificationClaim === true,
    });

    let handle: AgentShellProcessHandle;
    try {
      handle = this.startAgentProcess(req, sessionId, {
        enforceTimeout: false,
        statusFilePath,
      });
    } catch (spawnErr) {
      // 2026-05-18 review P0-3：spawn 失败时把 record 推到 'failed' 终态。
      this.managedTaskStore.updateOnExit(sessionId, {
        status: 'failed',
        exit_code: -1,
        exited_by: 'exec_failure',
      });
      // 2026-05-23 push 通知重构 commit 2：spawn 失败时**不** push（无 sessionId
      // 给 LLM，push 无意义）。详见 Electron bridge 同款注释。
      throw spawnErr;
    }

    const childPid = (handle as unknown as { pid?: number }).pid;
    if (typeof childPid === 'number' && childPid > 0) {
      this.managedTaskStore.setPid(sessionId, childPid);
    }

    if (req.signal) {
      const abortListener = () => {
        // 2026-05-18 review P0-4：abort 路径先标 'user_interrupt'。
        const ar = this.agentSessions.get(sessionId);
        if (ar) ar.pendingKillReason = 'user_interrupt';
        void this.killAgentSession(sessionId, 'SIGTERM').catch(() => {});
      };
      req.signal.addEventListener('abort', abortListener, { once: true });
      void handle.result.finally(() => {
        req.signal?.removeEventListener('abort', abortListener);
      });
    }

    return {
      sessionId,
      outputFilePath: record.tail?.getFilePath() ?? '',
    };
  }

  async readAgentSessionOutput(
    sessionId: string,
    opts?: AgentReadOptions,
  ): Promise<AgentReadResult> {
    const session = this.ptyManager.getSession(sessionId);
    const taskRecord = this.managedTaskStore.get(sessionId);
    if (!session) {
      if (!taskRecord) {
        throw new Error(`agent session not found: ${sessionId}`);
      }
      return archivedAgentOutput(taskRecord);
    }
    // RT-4 R1：cursor 增量读（与 Electron 对称）——sinceCursor 走 readFromCursor。
    const snapshot = this.ptyManager.getSessionOutput(
      sessionId,
      opts?.sinceCursor != null ? { sinceCursor: opts.sinceCursor } : undefined,
    );
    if (!snapshot) {
      if (!taskRecord) {
        throw new Error(`agent session not found: ${sessionId}`);
      }
      return archivedAgentOutput(taskRecord);
    }
    // RT-4 R1：cursor 增量路径——snapshot.output 已是从 sinceCursor 起的增量。
    // 无 cursor 时回退旧 byteOffset 全量切片（首轮 / 终态 sinceByteOffset:0）。
    const incremental = incrementalAgentOutput(snapshot.output, opts);
    return {
      output: incremental,
      outputBytes: snapshot.metadata.totalBytes,
      isRunning: snapshot.metadata.isRunning,
      exitCode: snapshot.metadata.lastExitCode,
      cwd: snapshot.metadata.cwd,
      lastOutputAt: snapshot.metadata.lastOutputAt,
      truncated: snapshot.metadata.overflowed,
      nextCursor: snapshot.metadata.nextCursor,
      exitedBy: taskRecord?.exited_by,
      killedReason: taskRecord?.killed_reason,
      outputFilePath: taskRecord?.output_file_path || undefined,
      pid: taskRecord?.pid,
    };
  }

  async killAgentSession(sessionId: string, signal?: AgentKillSignal): Promise<void> {
    const record = this.agentSessions.get(sessionId);
    if (record?.processRunning) {
      // run-terminal-command_后台执行重构_2026-05-18 §4.2：标记 pendingKillReason
      // 让 handle.result.then 写 ManagedTask record 用准确的 killed_reason。
      record.pendingKillReason = record.pendingKillReason ?? 'kill_tool';
      record.process?.kill(signal);
      record.processRunning = false;
    }
    if (!this.ptyManager.has(sessionId)) {
      // P1-D 幂等（agent-bridge.ts L625）：见过该 sessionId（在 agentSessions
      // 或 recentlyEnded）→ no-op resolve；完全没见过 → throw `agent session not found`。
      if (this.agentSessions.has(sessionId)) {
        this.cleanupSession(sessionId);
        return;
      }
      if (this.recentlyEndedSessions.has(sessionId)) {
        return;
      }
      throw new Error(`agent session not found: ${sessionId}`);
    }
    // P1-A signal 透传到 daemon-pty-manager.kill 的 signalOpts。
    const killOpts = mapAgentKillSignalToOptions(signal);
    // 标记 close reason 为 'kill'（产品 R1 P1-1）—— bridge.onExit listener
    // 读取后 emit AgentSessionClosed.reason 用对的值（避免硬编码 'exit'）。
    this.pendingCloseReasons.set(sessionId, 'kill');
    this.ptyManager.kill(sessionId, killOpts);
  }

  subscribe<E extends AgentSessionEventName>(
    event: E,
    handler: AgentSessionEventHandler<E>,
  ): AgentSessionUnsubscribe {
    const list = this.subscribers[event];
    if (!list.includes(handler as never)) {
      list.push(handler as never);
    }
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const idx = list.indexOf(handler as never);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  // ==================== Internal Helpers ====================

  /**
   * spawn bridge 路径 agent transcript session：
   *   1. 检查 per-space limit（撞墙 → throw 含 `agent session limit reached` 关键词）
   *   2. 调 `ptyManager.spawn(sessionId, { cwd, synthetic: true })` 起 transcript session
   *   3. 设 `session.spaceId` + `session.agentMeta`
   *   4. emit `agent-session-created` 到 bridge subscribers（完整 schema）+
   *      logger.info({ event: 'agent_session_created', ... }) 结构化日志
   *   5. attach `session.pty.onExit` listener → emit `agent-session-closed`
   *   6. detached 模式：attach AgentOutputTail 持续写盘
   *   7. **不调** `setThreadSession`
   */
  private spawnAgentBridgeSession(
    req: AgentCommandRequest,
    mode: 'foreground' | 'detached',
  ): string {
    const spaceId = req.agentMeta.spaceId;
    const running = this.countRunningAgentSessions(spaceId);
    if (running >= MAX_AGENT_SESSIONS_PER_SPACE) {
      throw new Error(
        `agent session limit reached for space ${spaceId}: ${running}/${MAX_AGENT_SESSIONS_PER_SPACE}`,
      );
    }

    const sessionId = `agent-${spaceId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    // P1-E：Daemon 端 bridge 传 spaceId / env 到底层 spawn，让 transcript
    // session 拿到 TABTIN_SPACE_ID env + 与 Electron 等价的 session 形态。
    const success = this.ptyManager.spawn(sessionId, {
      cwd: req.cwd,
      spaceId,
      env: req.env,
      synthetic: true,
    });
    if (!success) {
      // P1-L：spawn 返回 false 真实原因区分（含关键词便于 ShellCap 上层解析）。
      const total = this.ptyManager.getSessionCount();
      throw new Error(
        `agent session limit reached or agent transcript session failure for space ${spaceId} (total sessions: ${total})`,
      );
    }
    const session = this.requireSession(sessionId);
    session.spaceId = spaceId;
    session.agentMeta = req.agentMeta;

    const createdPayload: AgentSessionCreated = {
      sessionId,
      spaceId,
      threadId: req.agentMeta.threadId ?? null,
      agentId: req.agentMeta.agentId,
      toolUseId: req.agentMeta.toolUseId,
      cwd: session.cwd,
      command: req.command,
      source: 'agent',
      ...(req.agentMeta.description !== undefined
        ? { description: req.agentMeta.description }
        : {}),
    };
    this.emitCreated(createdPayload);

    // 结构化日志（总控 L403 / agent-bridge.ts L412-415 硬契约）：
    // 用一行 message + JSON args 的形态，让运维 grep `agent_session_created`
    // 关键词能命中，同时 args object 走 logger 的 JSON.stringify 保留全字段。
    // L-WP6-1：日志带 command 完整字符串（不截断），便于运维 grep 命令体定位
    // 异常 session（hook 端只用首行截断作 tab title，是 UI 侧本地需求）。
    this.logger.info(
      '[bridge] agent_session_created',
      {
        event: 'agent_session_created',
        sessionId: createdPayload.sessionId,
        spaceId: createdPayload.spaceId,
        threadId: createdPayload.threadId,
        agentId: createdPayload.agentId,
        toolUseId: createdPayload.toolUseId,
        cwd: createdPayload.cwd,
        command: createdPayload.command,
        mode,
      } as const,
    );

    // attach onExit listener for emit closed
    const extraDisposables: PtyHostDisposable[] = [];
    const onExitDisposable = session.pty.onExit((evt: { exitCode: number | null; signal?: number }) => {
      // 已 emit 过 close → no-op（killAgentSession 路径会先 cleanup）
      if (!this.agentSessions.has(sessionId)) return;
      // P1-D 产品 R1：reason 从 pendingCloseReasons 拿（killAgentSession 显式
      // 标记），否则默认 'exit'。`evictIdleSessions` 路径目前归 'exit'（不完美但
      // 准确度足够运维 grep）。
      const reason: AgentSessionCloseReason = this.pendingCloseReasons.get(sessionId) ?? 'exit';
      this.pendingCloseReasons.delete(sessionId);
      this.cleanupSession(sessionId);
      this.emitClosed({ sessionId, spaceId, reason });
      this.logger.info('[bridge] agent_session_closed', {
        event: 'agent_session_closed',
        sessionId,
        spaceId,
        reason,
        exitCode: evt.exitCode,
      } as const);
    });
    extraDisposables.push(onExitDisposable);

    let tail: AgentOutputTail | null = null;
    if (mode === 'detached') {
      tail = AgentOutputTail.create(sessionId, {
        logger: {
          warn: (msg: string) => this.logger.warn(msg),
        },
      });
    }

    this.agentSessions.set(sessionId, {
      sessionId,
      spaceId,
      agentMeta: req.agentMeta,
      tail,
      process: null,
      processRunning: false,
      watchdog: null,
      mode,
      extraDisposables,
    });

    return sessionId;
  }

  private startAgentProcess(
    req: AgentCommandRequest,
    sessionId: string,
    options: {
      timeoutMs?: number;
      enforceTimeout: boolean;
      /**
       * Layer 2 退出码 sidecar 落盘路径（治 F9）。仅 detached 后台路径传入——
       * 前台 `executeAgentCommand` 直接从子进程 exit 拿码、无需 sidecar。
       */
      statusFilePath?: string;
    },
  ): AgentShellProcessHandle {
    const record = this.requireAgentRecord(sessionId);
    const session = this.requireSession(sessionId);
    this.ptyManager.markAgentTranscriptRunning(sessionId);
    this.ptyManager.appendAgentTranscriptData(sessionId, `$ ${req.command}\r\n`);
    const watchdog = record.mode === 'detached'
      ? new AgentPromptStallWatchdog({
          onStall: (tail) => {
            const warning =
              '\r\n[TabTin] Background command appears to be waiting for interactive input. ' +
              'Run `kill <pid>` (pid in the running envelope) via `run_terminal_command` to stop it, then rerun with piped input or a non-interactive flag.\r\n' +
              `Last output:\r\n${tail.trimEnd()}\r\n`;
            this.ptyManager.appendAgentTranscriptData(sessionId, warning);
            record.tail?.write(cleanOutput(warning));
            this.logger.warn('[bridge] background command appears to be waiting for interactive input', {
              event: 'agent_session_stalled_on_prompt',
              sessionId,
              spaceId: record.spaceId,
            } as const);
          },
        })
      : null;
    record.watchdog = watchdog;
    watchdog?.start();

    // 进度节流 dispatcher（2026-05-17，配合 streaming tool_progress 协议）：
    // 跟 ElectronPtyManagerBridge 同款（两端共用 terminal-core 的 helper 避免
    // 漂移）。foreground 长跑命令期间 bridge 把 stdout 按"5s 或 1KB"先到为准
    // 触发 ShellCap 传入的 onProgress 回调，让前端 TerminalCard 实时刷新。
    const progressDispatcher = createAgentProgressDispatcher({
      onProgress: req.onProgress,
    });

    let handle: AgentShellProcessHandle;
    try {
      // 2026-05-18 review P0-8 上线必修：Daemon 端必须 detached: false。
      // Daemon 进程可能被 kill -9 / crash / 重启——detached: true 会让子进程
      // 成为新 session leader，父进程死时不收 SIGHUP → 孤儿进程持续吃 CPU
      // 占端口，用户感知"产品坏了"。dispose() 时再主动 kill running 兜底
      // （macOS 没有 PR_SET_PDEATHSIG 等价机制）。
      handle = spawnAgentShellProcess({
        command: req.command,
        cwd: req.cwd ?? session.cwd,
        env: req.env,
        timeoutMs: options.timeoutMs,
        enforceTimeout: options.enforceTimeout,
        detached: false,
        // Layer 2 sidecar（治 F9）：detached 路径把退出码落盘，host 崩溃后启动对账读回。
        statusFilePath: options.statusFilePath,
        signal: req.signal,
        onOutput: (data) => {
          this.ptyManager.appendAgentTranscriptData(sessionId, data);
          const clean = cleanOutput(data);
          record.tail?.write(clean);
          watchdog?.recordOutput(clean);
          progressDispatcher.onChunk(clean);
          // run-terminal-command_后台执行重构_2026-05-18 §4.2：累加 stdout byte 到 ManagedTask record。
          if (record.mode === 'detached') {
            this.managedTaskStore.incrementOutputBytes(sessionId, Buffer.byteLength(clean, 'utf-8'));
          }
        },
      });
    } catch (err) {
      watchdog?.stop();
      record.watchdog = null;
      progressDispatcher.dispose();
      this.ptyManager.markAgentTranscriptCompleted(sessionId, {
        cwd: session.cwd,
        exitCode: null,
      });
      this.ptyManager.appendAgentTranscriptData(
        sessionId,
        `\r\nFailed to start shell process: ${err instanceof Error ? err.message : String(err)}\r\n`,
      );
      throw err;
    }

    record.process = handle;
    record.processRunning = true;

    void handle.result.then((result) => this.completeAgentProcess(sessionId, handle, result, options.timeoutMs)).finally(() => {
      // flush 最后一帧 progress + 停 timer（防 setTimeout 泄漏）
      progressDispatcher.dispose();
    });

    return handle;
  }

  private completeAgentProcess(sessionId: string, handle: AgentShellProcessHandle, result: AgentShellProcessResult, timeoutMs?: number): void {
    const current = this.agentSessions.get(sessionId);
    if (!current || current.process !== handle) return;
    current.processRunning = false;
    current.watchdog?.stop();
    current.watchdog = null;
    this.ptyManager.markAgentTranscriptCompleted(sessionId, { cwd: result.cwd, exitCode: result.exitCode });
    if (result.timedOut) this.ptyManager.appendAgentTranscriptData(sessionId, `\r\nCommand timed out after ${timeoutMs ?? DEFAULT_AGENT_COMMAND_TIMEOUT_MS}ms\r\n`);
    if (current.mode !== 'detached') return;
    const killReason: KilledReason | undefined = current.pendingKillReason ?? (result.timedOut ? 'hard_timeout' : undefined);
    const exitedBy = agentExitedBy(killReason, result.exitCode);
    this.managedTaskStore.updateOnExit(sessionId, { status: killReason ? 'killed' : 'completed', exit_code: result.exitCode ?? -1, exited_by: exitedBy, killed_reason: killReason });
    this.emitPushNotificationOnExit(sessionId, result.exitCode ?? -1, exitedBy, killReason);
    void current.tail?.close().catch(() => {});
  }

  private countRunningAgentSessions(spaceId: string): number {
    let n = 0;
    for (const record of this.agentSessions.values()) {
      if (record.spaceId !== spaceId) continue;
      if (record.processRunning) n++;
    }
    return n;
  }

  /**
   * owner 固化（终端假运行根治 Layer 1 / 治 F1）：spawn 时解析命令归属。
   * 走注入的 ownerResolver（daemon.ts 提供 config.{user_id, organization_id}）。
   * best-effort：未注入 / 抛错 → undefined（record 不带 owner，回落 gateway 默认）。
   */
  private resolveManagedTaskOwner(): ManagedTaskOwner | undefined {
    try {
      return this.ownerResolver?.();
    } catch {
      return undefined;
    }
  }

  private requireSession(sessionId: string): PtySession {
    const s = this.ptyManager.getSession(sessionId);
    if (!s) throw new Error(`agent session not found right after spawn: ${sessionId}`);
    return s;
  }

  private requireAgentRecord(sessionId: string): AgentSessionRecord {
    const r = this.agentSessions.get(sessionId);
    if (!r) throw new Error(`bridge agent record missing: ${sessionId}`);
    return r;
  }

  /**
   * 2026-05-23 push 通知重构 commit 2/3：在 detached 任务退出时往 NotificationQueue
   * push 一条 background-task-completed 通知。
   *
   * **行为完全跟 ElectronPtyManagerBridge.emitPushNotificationOnExit 对齐**
   * （contract test 不验本方法——bridge 私有 helper——但语义必须一致以保证
   * 跨端 push 行为可预测）。
   *
   * **触发条件**（必须全部满足，否则 no-op）：
   *   1. ManagedTaskStore 里有 record（spawn 成功）
   *   2. record.notification_state === 'background_exposed'（ShellCap 已经返回
   *      status:"running"，用户/LLM 知道这条任务在后台跑）
   *   3. record.killed_reason !== 'app_exit'（退出 flush 已同步 relay app_exit 终态）
   *   4. record.threadId 非空（有业务对话 thread 上下文可路由）
   *
   * **注**：notificationQueue 在 ctor 已确保非空（commit 3 改成 bridge 内置必有，
   * 默认 internal new + startGc），此处不需要 if (!this.notificationQueue) 兜底。
   *
   */
  private emitPushNotificationOnExit(
    sessionId: string,
    exitCode: number,
    exitedBy: ExitedBy,
    killedReason: KilledReason | undefined,
  ): void {
    const record = this.managedTaskStore.get(sessionId);
    if (!record) return;
    if (record.notified === true) return;
    if (record.sync_notification_claim === true) return;
    if (record.notification_state !== 'background_exposed') return;
    if (record.killed_reason === 'app_exit') return;
    const routeThreadId = resolveNotificationRouteThreadId(record);
    if (!routeThreadId) return;

    const completedAt = record.completed_at ?? Date.now();
    const durationMs = Math.max(0, completedAt - record.started_at);
    const priority: NotificationPriority = killedReason === 'hard_timeout' ? 'next' : 'later';

    const env: NotificationEnvelope<BackgroundTaskCompletedPayload> = {
      kind: 'background-task-completed',
      target: {
        spaceId: record.spaceId,
        threadId: routeThreadId,
      },
      priority,
      payload: {
        agent_session_id: sessionId,
        tool_use_id: record.toolUseId,
        command: record.command,
        description: record.description,
        exit_code: exitCode === -1 ? null : exitCode,
        exited_by: exitedBy,
        killed_reason: killedReason,
        duration_ms: durationMs,
        output_file_path: record.output_file_path,
        pid: record.pid,
        cwd: record.cwd,
        // owner 固化（治 F1）：把 spawn 时焊死的 owner 透传给 host 终态投递。
        owner: record.owner,
        business_thread_id: record.threadId,
      },
      enqueuedAt: Date.now(),
      dedupKey: sessionId,
    };

    try {
      this.notificationQueue.enqueue(env);
    } catch (err) {
      this.logger.warn(
        `[DaemonPtyManagerBridge] notificationQueue.enqueue threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private cleanupSession(sessionId: string): void {
    const record = this.agentSessions.get(sessionId);
    if (!record) return;
    if (record.processRunning) {
      record.process?.kill('SIGTERM');
      record.processRunning = false;
    }
    record.watchdog?.stop();
    record.watchdog = null;
    for (const d of record.extraDisposables) {
      try {
        d.dispose();
      } catch {
        /* best-effort */
      }
    }
    void record.tail?.close().catch(() => {});
    this.agentSessions.delete(sessionId);
    this.markRecentlyEnded(sessionId);
  }

  /** P1-D：把 sessionId 加入 recentlyEnded，LRU 淘汰 + TTL evict。 */
  private markRecentlyEnded(sessionId: string): void {
    const now = Date.now();
    for (const [sid, endedAt] of this.recentlyEndedSessions) {
      if (now - endedAt > RECENTLY_ENDED_TTL_MS) {
        this.recentlyEndedSessions.delete(sid);
      }
    }
    while (this.recentlyEndedSessions.size >= RECENTLY_ENDED_MAX_SIZE) {
      const oldestKey = this.recentlyEndedSessions.keys().next().value;
      if (oldestKey === undefined) break;
      this.recentlyEndedSessions.delete(oldestKey);
    }
    this.recentlyEndedSessions.set(sessionId, now);
  }

  private emitCreated(event: AgentSessionCreated): void {
    const handlers = Array.from(this.subscribers['agent-session-created']);
    for (const h of handlers) {
      try {
        const ret = (h as (e: AgentSessionCreated) => unknown)(event);
        const maybePromise = ret as { catch?: (...args: unknown[]) => unknown } | undefined | null;
        if (maybePromise && typeof maybePromise.catch === 'function') {
          (ret as Promise<unknown>).catch((err) => {
            this.logger.warn(
              `[DaemonPtyManagerBridge] async handler for agent-session-created rejected: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }
      } catch (err) {
        this.logger.warn(
          `[DaemonPtyManagerBridge] sync handler for agent-session-created threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private emitClosed(event: AgentSessionClosed): void {
    const handlers = Array.from(this.subscribers['agent-session-closed']);
    for (const h of handlers) {
      try {
        const ret = (h as (e: AgentSessionClosed) => unknown)(event);
        const maybePromise = ret as { catch?: (...args: unknown[]) => unknown } | undefined | null;
        if (maybePromise && typeof maybePromise.catch === 'function') {
          (ret as Promise<unknown>).catch((err) => {
            this.logger.warn(
              `[DaemonPtyManagerBridge] async handler for agent-session-closed rejected: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }
      } catch (err) {
        this.logger.warn(
          `[DaemonPtyManagerBridge] sync handler for agent-session-closed threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}

// ==================== Factory（供 daemon.ts 装配方调用） ====================

/**
 * Daemon 端 bridge 实例 factory。
 *
 * **bootstrap 调用方契约**：
 *   - `TabTinDaemon.startTerminal()` （PtyManager.initialize 成功后）调本
 *     函数 + 调 `setPtyManagerBridge(bridge)` 完成注入
 *   - `DaemonToolProvider` 装配 ShellCap 前从 daemon 拿 bridge 实例
 *
 * 启动时**首次** create 同时跑 `runAgentOutputTailGC()`（agent-bridge.ts
 * L349 硬契约）。该函数返回新实例（不维护单例 —— 多 daemon 实例场景下
 * 各自 bridge），调用方自行缓存。
 */
export function createDaemonPtyManagerBridge(
  ptyManager: DaemonPtyManager,
  logger: Logger,
  options: { ownerResolver?: ManagedTaskOwnerResolver } = {},
): DaemonPtyManagerBridge {
  const bridge = new DaemonPtyManagerBridge(ptyManager, logger, {
    ownerResolver: options.ownerResolver,
  });
  void runAgentOutputTailGC({
    logger: {
      warn: (msg: string) => logger.warn(msg),
    },
  }).catch((err: unknown) => {
    logger.warn(
      `[DaemonPtyManagerBridge] startup GC failed (non-critical): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  return bridge;
}

// ==================== Utility types & helpers ====================

class AbortError extends Error {
  override readonly name = 'AbortError';
}

/**
 * 把 `AgentKillSignal` 映射成 daemon-pty-manager.kill 的 signalOpts（P1-A）：
 *   - 'SIGINT'  → SIGINT 温和中断；5s 后 SIGKILL 兜底
 *   - 'SIGTERM' / undefined → 默认（不传 opts 走 daemon 内部默认）
 *   - 'SIGKILL' → 立即 SIGKILL
 */
function mapAgentKillSignalToOptions(
  signal: AgentKillSignal | undefined,
):
  | undefined
  | {
      gracefulSignal?: NodeJS.Signals;
      forceSignal?: NodeJS.Signals;
      forceAfterMs?: number;
    } {
  if (!signal || signal === 'SIGTERM') return undefined;
  if (signal === 'SIGINT') {
    return { gracefulSignal: 'SIGINT', forceSignal: 'SIGKILL', forceAfterMs: 5000 };
  }
  return { gracefulSignal: 'SIGKILL', forceSignal: 'SIGKILL', forceAfterMs: 0 };
}
