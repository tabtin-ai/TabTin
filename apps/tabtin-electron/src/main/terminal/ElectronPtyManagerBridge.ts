/**
 * ElectronPtyManagerBridge — WP2 Electron 端 PtyManagerBridge 实现。
 *
 * **业务定位**：把 Electron 主进程的 `PtyManager`（apps/tabtin-electron/src/main/terminal/PtyManager.ts）
 * 包成 `PtyManagerBridge` 接口形态，供本地 LLM ShellCap 通过
 * `setPtyManagerBridge` / `resolvePtyManagerBridge` 调用。命令本身由一次性
 * child process 执行；PtyManager 只创建 Terminal Tab transcript，让用户能实时看输出。
 *
 * **关键设计取舍**（agent-bridge.ts JSDoc 硬约束）：
 *   - **不走 `spawnAgentSession` 也不走 `getOrSpawnAgentSession`**（L559-562）：
 *     bridge 路径每次新 session，不复用 thread；4 件套人控路径继续用
 *     `spawnAgentSession` / `getOrSpawnAgentSession`，互不污染。
 *   - **EventEmitter 复用 + 双 emit**（L640-644）：bridge 自己维护
 *     `subscribers` Map 处理含完整 schema 的事件（toolUseId / agentId 必带），
 *     同时**额外**调 `ptyManager.emit('agent-session-created', {...})`
 *     用旧 schema 触发现有 IPC 通道（`window.tabtin?.pty.onAgentSessionCreated`）
 *     —— 让 WP3 的 renderer hook 不必改 IPC 链路即可工作。
 *   - **持续写盘走共享 helper `AgentOutputTail`**：与 Daemon 端同源避免漂移。
 *   - **subscribe 边界严格按 agent-bridge.ts L652-668**：单 handler 单例订阅
 *     / snapshot 语义 / async reject 吞错 / unsubscribe 幂等。
 *
 * **跟 4 件套的隔离性**（agent-bridge.ts L559-562 硬约束）：
 *   - bridge 路径起的 session sessionId 形态仍为 `agent-{spaceId}-{ts}-{rand4}`
 *     （与 4 件套保持字面一致，evictIdleSessions 等仍能识别），但不会调
 *     `setThreadSession` 把 threadId 绑到 session 上——4 件套的 thread→session
 *     复用语义不被污染。
 *   - 写到 `session.agentMeta` 字段（pty-core PtySession 已扩展该字段），让
 *     emit close 事件时能从 session 反查 toolUseId 等。
 */

import {
  AgentOutputTail,
  AgentPromptStallWatchdog,
  CommandValidationError,
  createAgentProgressDispatcher,
  DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
  evaluateAgentShellSecurityFloor,
  ManagedTaskStore,
  resolveNotificationRouteThreadId,
  NotificationQueue,
  runAgentOutputTailGC,
  SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER,
  spawnAgentShellProcess,
  tabtinAgentTaskStatusPath,
  type AgentCommandRequest,
  type AgentCommandResult,
  type AgentShellProcessHandle,
  type AgentKillSignal,
  type AgentReadOptions,
  type AgentReadResult,
  type AgentSessionCloseReason,
  type AgentSessionClosed,
  type AgentSessionCreated,
  type AgentSessionEventHandler,
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
import { DEFAULT_COLS, DEFAULT_ROWS, cleanOutput, type AgentSessionClosedInfo, type PtySession } from '@tabtin/pty-core';
import type { PtyManager } from './PtyManager';
import { getCLIOrganizationId } from '../cli/cli-context';
import { ensureCLIServerReady, getCLIServerInfo } from '../cli/cli-server';
import { TokenManager } from '../auth';
import { createLogger } from '../logger';

const log = createLogger('PtyManagerBridge');

// MAX_AGENT_SESSIONS_PER_SPACE 复用 PtyManager.ts 内的常量；这里硬编码本地
// 副本是为了让 bridge 在调 ptyManager.spawn 失败时（spawn 返回 false）能精确
// 给出 limit-reached 错误信息（带 limit 数字）。两端 limit 字面可不同——
// contract test 只验关键词 `agent session limit reached`（L571-575）。
const MAX_AGENT_SESSIONS_PER_SPACE = 6;
const CLI_SERVER_ENV_KEYS = ['TABTIN_SOCK', '_TABTIN_TRANSPORT_TOKEN'] as const;

function assertAgentShellSecurityFloor(req: AgentCommandRequest): void {
  const decision = evaluateAgentShellSecurityFloor(req.command);
  if (!decision.blocked) return;
  log.warn(
    `agent command blocked before spawn: toolUseId=${req.agentMeta.toolUseId}, ` +
      `rule=${decision.ruleName ?? 'unknown'}, cmdLen=${req.command.length}`,
  );
  throw new CommandValidationError(
    decision.denyReason ?? 'Command blocked by the agent shell security floor.',
    decision.ruleName,
  );
}

export function shouldDetachAgentProcessForPlatform(platform: NodeJS.Platform = process.platform): boolean {
  // On Windows, child_process detached=true allocates a new console window. Agent
  // commands run from the right chat rail must stay invisible and stream only
  // through the in-app terminal card. Unix keeps detached=true for process-group kill.
  return platform !== 'win32';
}

function mergeCurrentCLIServerEnv(
  env?: Record<string, string>,
): Record<string, string> | undefined {
  const withPreservedTransportKeys = (
    nextEnv: Record<string, string>,
    keys: readonly string[],
  ): Record<string, string> => {
    if (keys.length === 0) return nextEnv;
    const existing = nextEnv[SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER]
      ?.split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0) ?? [];
    return {
      ...nextEnv,
      [SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER]: [...new Set([...existing, ...keys])].join(','),
    };
  };

  if (env && ('TABTIN_SOCK' in env || '_TABTIN_TRANSPORT_TOKEN' in env)) {
    return withPreservedTransportKeys(
      env,
      CLI_SERVER_ENV_KEYS.filter((key) => key in env),
    );
  }

  const info = getCLIServerInfo();
  if (!info?.socketPath || !info.token) {
    return env;
  }

  return {
    ...withPreservedTransportKeys(
      {
        TABTIN_SOCK: info.socketPath,
        _TABTIN_TRANSPORT_TOKEN: info.token,
        ...(env ?? {}),
      },
      CLI_SERVER_ENV_KEYS,
    ),
  };
}

function withCurrentCLIServerEnv(req: AgentCommandRequest): AgentCommandRequest {
  const env = mergeCurrentCLIServerEnv(req.env);
  if (env === req.env) return req;
  return { ...req, env };
}

async function withReadyCLIServerEnv(req: AgentCommandRequest): Promise<AgentCommandRequest> {
  try {
    await ensureCLIServerReady();
  } catch (error) {
    log.error('CLI Server 自恢复失败，继续执行 Shell 命令:', error);
  }
  return withCurrentCLIServerEnv(req);
}

interface AgentSessionRecord {
  sessionId: string;
  spaceId: string;
  agentMeta: AgentCommandRequest['agentMeta'];
  tail: AgentOutputTail | null;
  process: AgentShellProcessHandle | null;
  processRunning: boolean;
  watchdog: AgentPromptStallWatchdog | null;
  /** 'detached' 模式下 process output 持续写盘；foreground 不需要（result.stdout 直接给 LLM）。 */
  mode: 'foreground' | 'detached';
  /**
   * run-terminal-command_后台执行重构_2026-05-18 §4.2 + 2026-05-18 review P0-4/P1-3：
   * 用户主动 kill / GC hard_timeout / kill_tool 时记下 reason，让 handle.result.then 写
   * ManagedTask record 时用准确的 killed_reason，与 PRD KilledReason 枚举对齐。
   */
  pendingKillReason?: 'kill_tool' | 'user_interrupt' | 'hard_timeout';
}

/**
 * P1-D 幂等：bridge 见过但已 cleanup 的 sessionId 保留在 LRU Set 里 N 分钟，
 * 后续 killAgentSession / readAgentSessionOutput 命中时 no-op resolve 而不
 * throw `not found`（agent-bridge.ts L625 / L610 硬契约）。
 */
const RECENTLY_ENDED_TTL_MS = 5 * 60 * 1000;
const RECENTLY_ENDED_MAX_SIZE = 256;

export class ElectronPtyManagerBridge implements PtyManagerBridge {
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
   * P2-AGT-1: 当 bridge 路径 spawn 出来的 session 自然 exit 时，PtyManager
   * 会 emit `agent-session-closed`（spaceId 触发条件，PtyManager.ts L328-343）。
   * bridge 把它 catch + 转 emit AgentSessionClosed 给订阅者。该 listener 在
   * dispose 时移除。
   */
  private readonly onPtyManagerSessionClosed: (event: AgentSessionClosedInfo) => void;
  /**
   * run-terminal-command_后台执行重构_2026-05-18 §4.2：
   * ManagedTask store —— 运行 quota 与 record TTL 解耦。
   * 默认 bridge 内部 new 一个，host 也可以注入共享实例（未来跨 bridge 共享时用）。
   * GC 默认随 bridge 启动启用；dispose 时停。
   */
  private readonly managedTaskStore: ManagedTaskStore;

  /**
   * 2026-05-23 push 通知重构 commit 2/3：notificationQueue 用来在后台命令退出时
   * push 通知激活父 Agent 下一轮 turn。
   *
   * **持有方式**（跟 ManagedTaskStore 同款）：bridge 内部默认 new 一个，
   * host 也可通过 options 注入共享实例（跨 bridge 共享 / 测试时用）。
   * GC 默认随 bridge 启动启用；dispose 时停。
   *
   * **commit 3 host 接入路径**：host 通过 `resolvePtyManagerBridge()` 拿 bridge →
   * `bridge.getNotificationQueue()` 拿 queue → `subscribe(listener)` 注册
   * idle drain 触发器。
   *
   * 详见 PRD §6.1 + §6.2 + §6.3 + §6.7（双端对称契约）。
   */
  private readonly notificationQueue: NotificationQueue;

  constructor(
    private readonly ptyManager: PtyManager,
    options: {
      managedTaskStore?: ManagedTaskStore;
      notificationQueue?: NotificationQueue;
    } = {},
  ) {
    this.notificationQueue = options.notificationQueue ?? new NotificationQueue({});
    this.notificationQueue.startGc();
    this.managedTaskStore =
      options.managedTaskStore ??
      new ManagedTaskStore({
        hardTimeoutHandlers: {
          // run-terminal-command_后台执行重构_2026-05-18 §6.2 / §6.6：6h SYSTEM_NOTICE。
          // bridge 不直接发 SYSTEM_NOTICE（那是 ShellCap 上层职责），这里 log warn
          // 让运维 / 主进程日志能 grep 到长跑任务；dogfood 期满后视 UI 需求决定
          // 是否扩 AgentSessionEventName 加 'agent-session-stalled' 给 host 转 UI。
          onWarning: (record) => {
            log.warn(
              `hard_timeout warning: session ${record.session_id} ` +
                `(command: ${record.command.slice(0, 80)}) has been running for >6h. ` +
                `Will SIGTERM at 12h if still running.`,
            );
          },
          onKill: async (sessionId: string) => {
            // 2026-05-18 review P1-3：12h 强杀 hook 必须标 killed_reason='hard_timeout'
            // 让 LLM 区分"系统兜底超时"与"我自己 kill / 用户中断"。
            const ar = this.agentSessions.get(sessionId);
            if (ar) ar.pendingKillReason = 'hard_timeout';
            try {
              await this.killAgentSession(sessionId, 'SIGTERM');
            } catch {
              // session 已没了，no-op
            }
          },
        },
      });
    this.managedTaskStore.startGc();

    this.onPtyManagerSessionClosed = (event) => {
      const record = this.agentSessions.get(event.sessionId);
      if (!record) return;
      // 4 件套人控路径起的 session 不在 agentSessions 中（bridge 不接管）；
      // 这里 early return 保证仅本 bridge 自己起的 session 触发 emit。
      // event.reason: PtySessionCloseReason；与 AgentSessionCloseReason 字面 1:1
      // 对齐（agent-bridge.ts L477-482 硬契约），contract test 自动断言。
      this.cleanupSession(event.sessionId);
      this.emitClosed({
        sessionId: event.sessionId,
        spaceId: event.spaceId,
        reason: event.reason as AgentSessionCloseReason,
      });
    };
    this.ptyManager.on('agent-session-closed', this.onPtyManagerSessionClosed);
  }

  /**
   * 调用方手动 dispose：清掉 PtyManager 上的 listener、关所有 tail fd。
   * **不**清理 agent-tasks 磁盘文件（让 LLM 后续仍能 read_file）。
   */
  async dispose(): Promise<void> {
    this.ptyManager.off('agent-session-closed', this.onPtyManagerSessionClosed);
    for (const sid of [...this.agentSessions.keys()]) {
      this.cleanupSession(sid);
    }
    this.subscribers['agent-session-created'].length = 0;
    this.subscribers['agent-session-closed'].length = 0;
    this.managedTaskStore.stopGc();
    this.notificationQueue.stopGc();
  }

  /**
   * 暴露 ManagedTaskStore 供 ShellCap / 测试访问。**只读**——bridge 内部状态。
   * ShellCap 的 dedup 查询（runSpawnSerialized / findDedupCandidate）走这个入口。
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
   * 负责——本方法只保证 poll 不再空等竞态窗口，并把终态原因标为用户中止。
   */
  requestKillAgentSession(sessionId: string): boolean {
    const record = this.agentSessions.get(sessionId);
    if (record) record.pendingKillReason = 'user_interrupt';
    return this.managedTaskStore.requestKill(sessionId);
  }

  /**
   * UI「停止后台任务」成功发出 kill 后，立即把用户中止作为后台任务终态通知入队。
   *
   * 不能只等子进程 exit handler：killAgentSession 只负责发送 SIGTERM，detached 子进程
   * 的 result 结算可能晚于 UI/Agent 的下一轮调度，甚至在边角下丢掉通知。这里先写
   * ManagedTask terminal state 并 enqueue `killed_reason:user_interrupt`，让 Agent
   * 及时知道这是用户主动中止；真实 exit handler 随后再触发时 `markNotified` 会挡住重复。
   */
  notifyAgentSessionUserInterrupted(sessionId: string): boolean {
    const record = this.managedTaskStore.get(sessionId);
    if (!record || record.status !== 'running') return false;
    this.managedTaskStore.updateOnExit(sessionId, {
      status: 'killed',
      exit_code: -1,
      exited_by: 'signal',
      killed_reason: 'user_interrupt',
    });
    const enqueued = this.emitPushNotificationOnExit(sessionId, -1, 'signal', 'user_interrupt');
    if (enqueued) this.managedTaskStore.markNotified(sessionId);
    return true;
  }

  /**
   * 2026-05-23 push 通知重构 commit 3：暴露 NotificationQueue 给 host 接入。
   *
   * **生产路径**：`ElectronAgentHost` 构造时调 `resolvePtyManagerBridge()`
   * 拿 bridge → 调本方法拿 queue → `queue.subscribe(listener)` 注册 idle drain
   * 触发器。详见 PRD §6.3。
   *
   * **跟 getManagedTaskStore 同款 access pattern**——bridge 是 queue 的所有者
   * （生命周期跟 bridge 绑定），host 是 consumer（只 subscribe 不直接 enqueue）。
   */
  getNotificationQueue(): NotificationQueue {
    return this.notificationQueue;
  }

  // ==================== PtyManagerBridge 接口 ====================

  async executeAgentCommand(req: AgentCommandRequest): Promise<AgentCommandResult> {
    if (req.signal?.aborted) {
      throw new AbortError(`executeAgentCommand: signal already aborted`);
    }
    assertAgentShellSecurityFloor(req);
    req = await withReadyCLIServerEnv(req);

    const sessionId = this.spawnAgentBridgeSession(req, 'foreground');
    const cwdAtSpawn = this.requireSession(sessionId).cwd;

    // P1-J 窗口期防御：spawn 后立即再检查 signal 是否已 aborted —— 防止
    // spawn 与 addEventListener 之间用户已 abort 但 listener 没生效的瞬死 tab。
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
    assertAgentShellSecurityFloor(req);
    req = await withReadyCLIServerEnv(req);

    const sessionId = this.spawnAgentBridgeSession(req, 'detached');
    const record = this.requireAgentRecord(sessionId);

    // P1-J 窗口期防御：spawn 后立即再检查 signal。
    if (req.signal?.aborted) {
      await this.killAgentSession(sessionId, 'SIGTERM').catch(() => {});
      throw new AbortError(`spawnAgentSessionDetached: signal aborted during spawn`);
    }

    // owner 固化（终端假运行根治 Layer 1 / 治 F1）：spawn 时 auth 一定有效
    // （命令正是在活跃 query 内发起），此刻解析 {userId, organizationId} 焊进 record。
    // 终态投递从 record 取 owner（而非临时 getCLIOrganizationId），丢 token / 切
    // organization 后仍能把终态落到正确 outbox 桶 recover。getUserInfo 走内存缓存
    // （preloadAuthData 后），不引入网络延迟。
    const owner = await this.resolveManagedTaskOwner();

    // Layer 2 退出码 sidecar（终端假运行根治 v3 / 治 F9）：与 output_file 同目录分配
    // `<session>.status`，传给 spawn 让 shell 进程退出前 echo $? 落盘；落进 record
    // 持久化字段，host 崩溃 / kill -9 后启动对账据它恢复真实退出码。
    const statusFilePath = tabtinAgentTaskStatusPath(sessionId);

    // run-terminal-command_后台执行重构_2026-05-18 §4.2：创建 ManagedTask record。
    // record lifecycle 与 PtySession 解耦：PtySession 5 秒后释放配额，
    // record 30 分钟 TTL 让 LLM 仍能 await 拿终态。
    // 2026-05-18 review P0-2：req.timeoutMs（来自 LLM hard_timeout_ms）透传到 store
    // 让 checkHardTimeout 用 per-record 阈值，而不是固定 12h。
    this.managedTaskStore.createRecord({
      session_id: sessionId,
      command: req.command,
      // LLM 的命令意图摘要——透传到 record，后台完成通知优先用它向用户展示。
      description: req.agentMeta.description ?? undefined,
      cwd: req.cwd ?? this.requireSession(sessionId).cwd,
      env: req.env,
      spaceId: req.agentMeta.spaceId,
      // threadId = 父对话（UI / relay）；notificationThreadId = drain 路由。
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
      // 2026-05-18 review P0-3：spawn 失败时把 record 推到 'failed' 终态，
      // 否则它永远停在 'running' 污染 dedup + GC（要等 12h kill handler）。
      this.managedTaskStore.updateOnExit(sessionId, {
        status: 'failed',
        exit_code: -1,
        exited_by: 'exec_failure',
      });
      // 2026-05-23 push 通知重构 commit 2：spawn 失败时**不** push。
      // bridge 抛错前没把 sessionId 返给 ShellCap，LLM 拿到的是 SPAWN_FAILURE
      // envelope（无 session_id），无法 await，也不会做"派去再回来"的等待循环；
      // push 一条"任务结束"通知对 LLM 是冗余信息。
      throw spawnErr;
    }

    // 2026-05-18 review P2-3：拿到 child handle 后回填 pid，让 unknown 分支
    // hint 给 LLM 的 `ps -p <pid>` 有真实值可用。
    const childPid = (handle as unknown as { pid?: number }).pid;
    if (typeof childPid === 'number' && childPid > 0) {
      this.managedTaskStore.setPid(sessionId, childPid);
    }

    if (req.signal) {
      const abortListener = () => {
        // 2026-05-18 review P0-4：abort 路径先标 'user_interrupt' 区别于显式 kill_tool。
        // killAgentSession 内部 `?? 'kill_tool'` 兜底逻辑会让原来所有 abort 都归
        // kill_tool，user_interrupt 永远不会出现——这里显式标好。
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
      // run-terminal-command_后台执行重构_2026-05-18 §4.2.3：
      // PtySession 5 秒延迟释放后，readAgentSessionOutput 仍能从 ManagedTask
      // record 拿终态（30 分钟 TTL）。读不到 stdout 内容（PtySession output
      // buffer 已释放），但能告知 LLM 任务终态 + record 字段透出。
      // (push 通知重构 commit B 后 await 工具已删，此路径主要给 dedup
      //  / readAgentSessionOutput 内部消费 + push 通知 producer 用)
      if (!taskRecord) {
        throw new Error(`agent session not found: ${sessionId}`);
      }
      return {
        output: '',
        outputBytes: taskRecord.stdout_byte_count,
        isRunning: taskRecord.status === 'running',
        exitCode: taskRecord.exit_code ?? null,
        cwd: taskRecord.cwd,
        lastOutputAt: taskRecord.last_output_at,
        truncated: false,
        // 2026-05-18 review P0-1：透出 record 终态字段让 await envelope 完整
        exitedBy: taskRecord.exited_by,
        killedReason: taskRecord.killed_reason,
        outputFilePath: taskRecord.output_file_path || undefined,
        pid: taskRecord.pid,
      };
    }
    // RT-4 R1：cursor 增量读——传 sinceCursor 让 PtyManager 走 readFromCursor
    // 只读新增 chunk，不再每轮 readAll 全量（前台 poll O(n²) 根因）。
    const snapshot = this.ptyManager.getSessionOutput(
      sessionId,
      opts?.sinceCursor != null ? { sinceCursor: opts.sinceCursor } : undefined,
    );
    if (!snapshot) {
      if (!taskRecord) {
        throw new Error(`agent session not found: ${sessionId}`);
      }
      return {
        output: '',
        outputBytes: taskRecord.stdout_byte_count,
        isRunning: taskRecord.status === 'running',
        exitCode: taskRecord.exit_code ?? null,
        cwd: taskRecord.cwd,
        lastOutputAt: taskRecord.last_output_at,
        truncated: false,
        exitedBy: taskRecord.exited_by,
        killedReason: taskRecord.killed_reason,
        outputFilePath: taskRecord.output_file_path || undefined,
        pid: taskRecord.pid,
      };
    }
    // RT-4 R1：cursor 增量路径——snapshot.output 已是从 sinceCursor 起的增量
    // （PtyManager 内 readFromCursor + cleanOutput 增量片段）。无 cursor 时回退
    // 旧 byteOffset 全量切片（首轮 / 终态 sinceByteOffset:0）。
    let incremental: string;
    if (opts?.sinceCursor != null) {
      incremental = snapshot.output;
    } else {
      const fullOutput = snapshot.output;
      const sinceByteOffset = opts?.sinceByteOffset ?? 0;
      const fullBytes = Buffer.byteLength(fullOutput, 'utf-8');
      if (sinceByteOffset >= fullBytes) {
        incremental = '';
      } else if (sinceByteOffset <= 0) {
        incremental = fullOutput;
      } else {
        // 字节偏移要按 utf-8 字节切，不能按 char 切（避免多字节字符截半）
        const buf = Buffer.from(fullOutput, 'utf-8');
        incremental = buf.subarray(sinceByteOffset).toString('utf-8');
      }
    }
    return {
      output: incremental,
      // RT-4 R1：outputBytes = buffer 累计字节（raw）；cursor 增量下不再用它切片。
      outputBytes: snapshot.metadata.totalBytes,
      isRunning: snapshot.metadata.isRunning,
      exitCode: snapshot.metadata.lastExitCode,
      cwd: snapshot.metadata.cwd,
      lastOutputAt: snapshot.metadata.lastOutputAt,
      // RT-4 R1：透出环形 buffer 溢出标记（evict 过则总量缺头）。
      truncated: snapshot.metadata.overflowed,
      nextCursor: snapshot.metadata.nextCursor,
      // 2026-05-18 review P0-1：PtySession 仍在时 record 已有的终态字段也透出
      // （比如 markAgentTranscriptCompleted 已写但 PtySession 5 秒延迟还没删的窗口）
      exitedBy: taskRecord?.exited_by,
      killedReason: taskRecord?.killed_reason,
      outputFilePath: taskRecord?.output_file_path || undefined,
      pid: taskRecord?.pid,
    };
  }

  async killAgentSession(sessionId: string, signal?: AgentKillSignal): Promise<void> {
    const record = this.agentSessions.get(sessionId);
    log.info(
      `killAgentSession: session=${sessionId}, signal=${signal ?? 'default'}, running=${!!record?.processRunning}`,
    );
    if (record?.processRunning) {
      // run-terminal-command_后台执行重构_2026-05-18 §4.2：标记 pendingKillReason
      // 让 handle.result.then 写 ManagedTask record 时用准确的 killed_reason。
      // 区分用户 abort（user_interrupt）vs LLM 显式 `kill <pid>`（kill_tool）：
      // killAgentSession 入口包含两种来源，统一标 kill_tool；user_interrupt 由
      // abortSignal 路径触发 kill 时单独覆盖（spawn 路径里）。
      // (push 通知重构 commit B 后 LLM 通过 run_terminal_command 跑
      //  `kill <pid>` 触发 kill，不再有专门的"kill 工具"心智)
      record.pendingKillReason = record.pendingKillReason ?? 'kill_tool';
      record.process?.kill(signal);
      record.processRunning = false;
    }
    if (!this.ptyManager.has(sessionId)) {
      // P1-D 幂等（agent-bridge.ts L625）：bridge 见过该 sessionId（在 agentSessions
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
    // P1-A signal 透传到 PtyManager.kill 的 signalOptions（PtyManager 内部
    // terminateProcessTree 接收 gracefulSignal / forceSignal / forceAfterMs）：
    //   - 'SIGINT'  → SIGINT 温和中断（不强杀，留进程自己处理）
    //   - 'SIGTERM' → 默认，SIGTERM 750ms 后 SIGKILL（保留原行为）
    //   - 'SIGKILL' → 立即 SIGKILL
    const killOpts = mapAgentKillSignalToOptions(signal);
    this.ptyManager.kill(sessionId, 'kill', killOpts);
  }

  subscribe<E extends AgentSessionEventName>(
    event: E,
    handler: AgentSessionEventHandler<E>,
  ): AgentSessionUnsubscribe {
    const list = this.subscribers[event];
    // 单 handler 单例订阅语义（agent-bridge.ts L653-656）
    if (!list.includes(handler as never)) {
      list.push(handler as never);
    }
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return; // 幂等（L666-668）
      unsubscribed = true;
      const idx = list.indexOf(handler as never);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  // ==================== Internal Helpers ====================

  /**
   * spawn 一个 bridge 路径专用的 agent transcript session：
   *   1. 检查 per-space limit（撞墙 → throw 含 `agent session limit reached` 关键词）
   *   2. 调 `ptyManager.spawn(sessionId, { spaceId, synthetic: true })` 起 transcript session
   *   3. 设 `session.spaceId` + `session.agentMeta`
   *   4. **额外** emit `agent-session-created` 到 PtyManager EventEmitter
   *      （旧 schema，让现有 IPC `window.tabtin?.pty.onAgentSessionCreated` 链路工作）
   *   5. emit `agent-session-created` 到 bridge subscribers（完整 schema 含 toolUseId / agentId）
   *   6. detached 模式：attach AgentOutputTail 持续写盘
   *   7. **不调** `setThreadSession`（D3 / agent-bridge.ts L559-562）
   *
   * 时序：步骤 4-5 emit 必须在步骤 6 attach 之前完成，但都在 executeCommand 之前
   * （契约 L419-421 / L559-564）。
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
    const success = this.ptyManager.spawn(sessionId, {
      cwd: req.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      spaceId,
      env: req.env,
      synthetic: true,
    });
    if (!success) {
      // P1-L：spawn 返回 false 真实原因区分。Electron PtyManager.spawn 失败有 2 类：
      //   1. 全局 MAX_SESSIONS = 20 撞墙（PtyManager.ts L796-799）
      //   2. transcript session 创建异常被内部 try/catch 转 false（PtyManager.ts L899-918）
      // 两类对 LLM 决策完全不同——前者建议 ask_user 关闭一些 tab、后者建议
      // ask_user 检查 transcript 环境 / 重启 app。bridge 无法精确区分，给出复合 message
      // 但**关键词分两条**让 ShellCap 上层结构化解析。
      const total = this.ptyManager.getSessionCount();
      // 含 'agent session limit reached' 关键词（contract L571-575 兼容）+ 含
      // 'or pty spawn failure' 作为后置消歧 hint，LLM / 用户看到能正确决策。
      throw new Error(
        `agent session limit reached or agent transcript session failure for space ${spaceId} (total sessions: ${total})`,
      );
    }
    const session = this.requireSession(sessionId);
    session.spaceId = spaceId;
    session.agentMeta = req.agentMeta;

    // 步骤 4：emit 旧 schema 给 PtyManager EventEmitter，让现有 IPC 链路转发
    // 给 renderer（WP3 不必改 IPC，agent-bridge.ts L429-432 / L640-644）。
    // P1-B：必须带 description —— 让 renderer Tab title fallback 链（hook L96-98）
    // 不退化到 sessionId 后 6 位（agent-bridge.ts 硬契约：description ∶∶
    // command 截断 ∶∶ sessionId）。IPC schema 同步加 description 字段。
    // L-WP6-1：补 command 字段透传到 IPC payload —— hook 端 description 缺失时
    // 用 command 首行截断作 tab title，让 dogfood「连跑 3 条命令」能区分。
    this.ptyManager.emit('agent-session-created', {
      sessionId,
      spaceId,
      threadId: req.agentMeta.threadId ?? null,
      cwd: session.cwd,
      description: req.agentMeta.description ?? null,
      command: req.command,
    });

    // 步骤 5：emit 完整 schema 给 bridge subscribers
    const createdEvent: AgentSessionCreated = {
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
    this.emitCreated(createdEvent);

    // 步骤 6：detached 模式 attach AgentOutputTail（共享 helper，与 Daemon 同源）
    let tail: AgentOutputTail | null = null;
    if (mode === 'detached') {
      tail = AgentOutputTail.create(sessionId, {
        logger: {
          warn: (msg: string) => log.warn(msg),
        },
      });
      this.agentSessions.set(sessionId, {
        sessionId,
        spaceId,
        agentMeta: req.agentMeta,
        tail,
        process: null,
        processRunning: false,
        watchdog: null,
        mode,
      });
    } else {
      this.agentSessions.set(sessionId, {
        sessionId,
        spaceId,
        agentMeta: req.agentMeta,
        tail: null,
        process: null,
        processRunning: false,
        watchdog: null,
        mode,
      });
    }

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
          },
        })
      : null;
    record.watchdog = watchdog;
    watchdog?.start();

    // 进度节流 dispatcher（2026-05-17，配合 streaming tool_progress 协议）：
    // foreground 长跑命令期间，bridge 把 stdout 按"5s 或 1KB"先到为准触发
    // ShellCap 传入的 onProgress 回调；ShellCap 在回调里 emit SYSTEM_NOTICE
    // 给前端 TerminalCard 实时刷新。dispose 在 handle.result.finally 触发，
    // 保证 timer 不泄漏。detached 路径不注入 onProgress → dispatcher 走零
    // 开销 no-op 分支（detached 有 transcript tail 通道，不依赖 progress）。
    const progressDispatcher = createAgentProgressDispatcher({
      onProgress: req.onProgress,
    });

    let handle: AgentShellProcessHandle;
    log.info(
      `agent command start: session=${sessionId}, mode=${record.mode}, ` +
        `cwd=${req.cwd ?? session.cwd}, cmdLen=${req.command.length}, timeoutMs=${options.timeoutMs}`,
    );
    try {
      // 2026-05-18 review P0-8：Electron Unix 端用 detached: true。
      // Windows detached=true 会弹出独立控制台窗口，右侧 Agent/Chat 命令必须隐藏执行。
      handle = spawnAgentShellProcess({
        command: req.command,
        cwd: req.cwd ?? session.cwd,
        env: req.env,
        timeoutMs: options.timeoutMs,
        enforceTimeout: options.enforceTimeout,
        detached: shouldDetachAgentProcessForPlatform(),
        // Layer 2 sidecar（治 F9）：detached 路径把退出码落盘，host 崩溃后启动对账读回。
        statusFilePath: options.statusFilePath,
        signal: req.signal,
        onOutput: (data) => {
          this.ptyManager.appendAgentTranscriptData(sessionId, data);
          const clean = cleanOutput(data);
          record.tail?.write(clean);
          watchdog?.recordOutput(clean);
          progressDispatcher.onChunk(clean);
          // run-terminal-command_后台执行重构_2026-05-18 §4.2：
          // 累加 stdout byte count 到 ManagedTask record（detached 路径才有 record）。
          // 不每次 stat 文件——byte 在 hot path 上以 utf8 长度近似累加。
          if (record.mode === 'detached') {
            this.managedTaskStore.incrementOutputBytes(sessionId, Buffer.byteLength(clean, 'utf-8'));
          }
        },
      });
    } catch (err) {
      log.error(`agent command failed to start: session=${sessionId}`, err);
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

    void handle.result.then((result) => {
      const current = this.agentSessions.get(sessionId);
      if (!current || current.process !== handle) return;
      current.processRunning = false;
      current.watchdog?.stop();
      current.watchdog = null;
      log.info(
        `agent command finished: session=${sessionId}, exitCode=${result.exitCode}, timedOut=${result.timedOut}`,
      );
      this.ptyManager.markAgentTranscriptCompleted(sessionId, {
        cwd: result.cwd,
        exitCode: result.exitCode,
      });
      if (result.timedOut) {
        this.ptyManager.appendAgentTranscriptData(
          sessionId,
          `\r\nCommand timed out after ${options.timeoutMs ?? DEFAULT_AGENT_COMMAND_TIMEOUT_MS}ms\r\n`,
        );
      }
      // run-terminal-command_后台执行重构_2026-05-18 §4.2 + 2026-05-18 review P1-3：
      // 同步更新 ManagedTask record（detached 路径才有 record）。
      // exited_by 推断：
      //   - pendingKillReason 优先（含 user_interrupt / kill_tool / hard_timeout）→ status='killed'
      //   - timedOut → status='killed' + killed_reason='hard_timeout'
      //   - exit 126/127 → completed + exited_by='exec_failure'
      //   - 其他 → completed + exited_by='normal_exit'
      if (current.mode === 'detached') {
        const killReason: KilledReason | undefined = current.pendingKillReason
          ?? (result.timedOut ? 'hard_timeout' : undefined);
        const status = killReason ? 'killed' : 'completed';
        const exitedBy: ExitedBy = killReason
          ? 'signal'
          : result.exitCode === 126 || result.exitCode === 127
          ? 'exec_failure'
          : 'normal_exit';
        this.managedTaskStore.updateOnExit(sessionId, {
          status,
          exit_code: result.exitCode ?? -1,
          exited_by: exitedBy,
          killed_reason: killReason,
        });
        // 2026-05-23 push 通知重构 commit 2：producer enqueue。
        // 触发条件：
        //   1. record 存在（spawn 成功）
        //   2. notification_state 为 background_exposed（ShellCap 已经返回 running）
        //   3. 有 drain 路由键（notificationThreadId 或 threadId）
        //   4. notificationQueue 已注入（host 已接入 push 通知机制）
        // ：drain 走 notificationThreadId；UI / relay 仍用 threadId。
        // 详见 PRD §6.2 + §12.4（命令队列 / 通知）+ §17.6。
        this.emitPushNotificationOnExit(sessionId, result.exitCode ?? -1, exitedBy, killReason);
        void current.tail?.close().catch(() => {});
      }
    }).finally(() => {
      // flush 最后一帧 progress + 停 timer（防 setTimeout 泄漏）
      progressDispatcher.dispose();
    });

    return handle;
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
   * owner 固化（终端假运行根治 Layer 1 / 治 F1）：在 spawn 时解析当前命令归属
   * `{userId, organizationId}`，写进 `ManagedTaskRecord.owner`。
   *
   * 来源对齐 `ElectronAgentHost.resolveOwner`：
   *   - userId：`TokenManager.getUserInfo()`（兼容 id / user_id / userId 字段名）
   *   - organizationId：`getCLIOrganizationId()`（renderer 同步的当前 organization）
   *
   * **best-effort**：任一缺失 / 抛错 → 返回 undefined（record 不带 owner），
   * 终态投递回落 `getCLIOrganizationId()`，行为不劣化于固化前。spawn 不应因 owner
   * 解析失败而被打断（命令本身可以照常跑）。
   */
  private async resolveManagedTaskOwner(): Promise<ManagedTaskOwner | undefined> {
    try {
      const userInfo = (await TokenManager.getUserInfo()) as
        | { id?: unknown; user_id?: unknown; userId?: unknown }
        | null;
      const rawUserId = userInfo?.id ?? userInfo?.user_id ?? userInfo?.userId;
      const organizationId = getCLIOrganizationId();
      if (rawUserId == null || rawUserId === '' || !organizationId) return undefined;
      return { userId: String(rawUserId), organizationId };
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
   * 2026-05-23 push 通知重构 commit 2：在 detached 任务退出时往 NotificationQueue
   * push 一条 background-task-completed 通知。
   *
   * **触发条件**（必须全部满足，否则 no-op）：
   *   1. ManagedTaskStore 里有 record（spawn 成功）
   *   2. record.notification_state === 'background_exposed'（ShellCap 已经返回
   *      status:"running"，用户/LLM 知道这条任务在后台跑）
   *   3. record.killed_reason !== 'app_exit'（退出 flush 已同步 relay app_exit 终态）
   *   4. 有 drain 路由键（notificationThreadId 或 threadId）
   *
   * **注**：notificationQueue 在 ctor 已确保非空（默认 internal new + startGc），
   * 此处不需要 if (!this.notificationQueue) 兜底——commit 3 把 queue 提升为
   * bridge 内置必有资源（详见构造函数 JSDoc）。
   *
   * **dedup**：用 sessionId 作 dedupKey——防止 handle.result.then + spawn 失败 catch
   * 双触发同一个 record 的 producer 边角 race。
   *
   * **优先级**：hard_timeout kill 升级到 `'next'`（用户隐式同意"12 小时还没完应立即报告"）；
   * 其他正常完成 / kill_tool / user_interrupt / failed 走 `'later'`（不饿死用户输入）。
   *
   * （commandQueue + task.notified 对齐项）。
   */
  private emitPushNotificationOnExit(
    sessionId: string,
    exitCode: number,
    exitedBy: ExitedBy,
    killedReason: KilledReason | undefined,
  ): boolean {
    const record = this.managedTaskStore.get(sessionId);
    if (!record) return false;
    if (record.notified === true) return false;
    if (record.sync_notification_claim === true) return false;
    if (record.notification_state !== 'background_exposed') return false;
    if (record.killed_reason === 'app_exit') return false;
    const routeThreadId = resolveNotificationRouteThreadId(record);
    if (!routeThreadId) {
      log.warn(`shell completion notification skipped: route threadId missing (session=${sessionId})`);
      return false;
    }

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
        // owner 固化（治 F1）：把 spawn 时焊死的 owner 透传给 host 的终态投递，
        // 让 relay 从此取 outbox owner 而非临时 getCLIOrganizationId。
        owner: record.owner,
        business_thread_id: record.threadId,
      },
      enqueuedAt: Date.now(),
      dedupKey: sessionId,
    };

    try {
      this.notificationQueue.enqueue(env);
      return true;
    } catch (err) {
      // listener 抛错已经在 queue 内被吞，这里 catch 的是其他意外（理论上不该有）
      log.warn(
        `notificationQueue.enqueue threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /**
   * cleanup session 资源（agent-bridge.ts L330 / L345 硬契约：保留写盘文件）：
   *   - 关写盘 fd（不删文件）
   *   - 移除 data listener
   *   - 从 agentSessions Map 删除
   *   - 加入 recentlyEnded 让后续 kill/read 走幂等 no-op 而非 throw not found
   */
  private cleanupSession(sessionId: string): void {
    const record = this.agentSessions.get(sessionId);
    if (!record) return;
    if (record.processRunning) {
      record.process?.kill('SIGTERM');
      record.processRunning = false;
    }
    record.watchdog?.stop();
    record.watchdog = null;
    void record.tail?.close().catch(() => {});
    this.agentSessions.delete(sessionId);
    this.markRecentlyEnded(sessionId);
  }

  /** P1-D：把 sessionId 加入 recentlyEnded，LRU 淘汰 + TTL evict。 */
  private markRecentlyEnded(sessionId: string): void {
    const now = Date.now();
    // TTL evict 过期项
    for (const [sid, endedAt] of this.recentlyEndedSessions) {
      if (now - endedAt > RECENTLY_ENDED_TTL_MS) {
        this.recentlyEndedSessions.delete(sid);
      }
    }
    // 防 unbounded：超出 max 时按 insertion order 删最早
    while (this.recentlyEndedSessions.size >= RECENTLY_ENDED_MAX_SIZE) {
      const oldestKey = this.recentlyEndedSessions.keys().next().value;
      if (oldestKey === undefined) break;
      this.recentlyEndedSessions.delete(oldestKey);
    }
    this.recentlyEndedSessions.set(sessionId, now);
  }

  private emitCreated(event: AgentSessionCreated): void {
    // snapshot 语义（agent-bridge.ts L657-660）：迭代前拍快照，emit 期间
    // unsubscribe 不影响本次迭代但下次起生效。
    const handlers = Array.from(this.subscribers['agent-session-created']);
    for (const h of handlers) {
      try {
        // handler 签名是 void return，但用户写 async handler 时实际返回 Promise；
        // 用 unknown 中转避免 ts2345 / void truthiness 报错。
        const ret = (h as (e: AgentSessionCreated) => unknown)(event);
        const maybePromise = ret as { catch?: (...args: unknown[]) => unknown } | undefined | null;
        if (maybePromise && typeof maybePromise.catch === 'function') {
          (ret as Promise<unknown>).catch((err) => {
            log.warn(
              `async handler for agent-session-created rejected: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }
      } catch (err) {
        log.warn(
          `sync handler for agent-session-created threw: ${
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
            log.warn(
              `async handler for agent-session-closed rejected: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }
      } catch (err) {
        log.warn(
          `sync handler for agent-session-closed threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}

// ==================== Factory（供 bridge-core.ts re-export） ====================

let cachedBridge: ElectronPtyManagerBridge | null = null;

/**
 * Electron 端 bridge 实例的单例 factory。
 *
 * **bootstrap 调用方契约**：
 *   - `bridge-core.ts` 的 `setupCoreAPIs(...)` 在 PtyManager 单例 ready 后
 *     调本函数拿 bridge 实例
 *   - `ElectronToolProvider` 装配 ShellCap 之前 import 本函数 + 调
 *     `setPtyManagerBridge(bridge)` 完成注入
 *
 * 启动时**首次** create 同时跑 `runAgentOutputTailGC()`（agent-bridge.ts
 * L349 硬契约：PtyManager 启动时扫一次 GC，清理上次进程退出的残留）。
 */
export function getOrCreateElectronPtyManagerBridge(ptyManager: PtyManager): ElectronPtyManagerBridge {
  if (cachedBridge) return cachedBridge;
  cachedBridge = new ElectronPtyManagerBridge(ptyManager);
  // 启动时跑一次 GC（fire-and-forget；失败 log 不阻塞）
  void runAgentOutputTailGC({
    logger: {
      warn: (msg: string) => log.warn(msg),
    },
  }).catch((err: unknown) => {
    log.warn(
      `startup GC failed (non-critical): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  return cachedBridge;
}

/** 测试 teardown 用：清除单例。**生产代码不应调用**。 */
export function __resetElectronPtyManagerBridgeForTesting(): void {
  if (cachedBridge) {
    void cachedBridge.dispose();
    cachedBridge = null;
  }
}

// ==================== Utility types & helpers ====================

class AbortError extends Error {
  override readonly name = 'AbortError';
}

/**
 * 把 `AgentKillSignal` 映射成 `PtyManager.kill` 的 signalOpts（P1-A）：
 *   - 'SIGINT'  → SIGINT 温和中断；如进程不响应 5s 后 SIGKILL 兜底
 *   - 'SIGTERM' / undefined → SIGTERM + 750ms 回退 SIGKILL（保留默认）
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
  // SIGKILL
  return { gracefulSignal: 'SIGKILL', forceSignal: 'SIGKILL', forceAfterMs: 0 };
}
