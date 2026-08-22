/**
 * 终端进程退出能力 —— 两端 host（Electron / Daemon）共享的纯核心。
 *
 * relay ACK / 重试 / 持久化 / reconcile 由宿主 delivery 层拥有；本文件只保留：
 *   - `killProcessGroupSafe`：杀整组 + ESRCH 回退
 *   - `runBackgroundTaskExitFlush`：退出路径 seal-then-kill + 终态 flush
 *
 * 本模块对 electron / node-pty / gateway **零依赖**：所有 I/O（send / persist /
 * kill / 时钟 / 日志）都由调用方注入。
 */

import type { PersistedEntryOwner } from '../session/index.js';
import {
  buildBackgroundTaskTerminalResult as defaultBuildBackgroundTaskTerminalResult,
} from './background-task-terminal-result.js';

/** relay 一批 wire 事件（= engine `StreamEvent` 的最小结构，便于注入测试 / 跨包消费）。 */
export type RelayEvent = { type: string; payload: Record<string, unknown> };

export interface TerminalRelayLogger {
  info?: (msg: string) => void;
  warn: (msg: string) => void;
}

// ─── 杀整组（process.kill(-pid)） ──────────────────────────────────────

/**
 * 杀**整组**（`kill(-pid)`）；pid 缺失 / 进程已退 / 非组长一律静默吞错，并退化
 * 为单进程 `kill(pid)` 兜底。
 *
 * - Electron：spawn `detached:true`，pid 即组长 → `-pid` 杀整组消灭 detached 子孙；
 * - Daemon：spawn `detached:false`，`-pid` 命中 ESRCH → catch 回退单进程
 *   （OS / systemd control-group 兜底子孙，PRD §9 已认可）。
 *
 * `kill` 注入（生产传 `process.kill`，测试传 spy）。
 */
export function killProcessGroupSafe(
  kill: (pid: number, signal: NodeJS.Signals) => void,
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (typeof pid !== 'number' || pid <= 0) return;
  try {
    kill(-pid, signal);
  } catch {
    // 进程组可能已不存在 / pid 非组长（daemon detached:false）；退化单进程兜底。
    try {
      kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

// ─── 退出 flush（路线 A / F-EXIT：杀整组 + 同步 flush 终态） ─────────────

/** 退出 flush 关注的 running record 子集（结构化，避免反耦合 terminal-core）。 */
export interface ExitFlushRunningRecord {
  session_id: string;
  status: string;
  pid?: number;
  threadId?: string;
  toolUseId: string;
  command: string;
  started_at: number;
  output_file_path: string;
  cwd: string;
  owner?: PersistedEntryOwner;
}

/** flush 需要的 ManagedTaskStore 子集（结构化）。 */
export interface ExitFlushStore {
  list(): ExitFlushRunningRecord[];
  updateOnExit(
    sessionId: string,
    result: {
      status: 'completed' | 'killed' | 'failed';
      exit_code: number;
      exited_by: 'normal_exit' | 'exec_failure' | 'signal';
      killed_reason?: 'hard_timeout' | 'kill_tool' | 'user_interrupt' | 'app_exit';
    },
  ): void;
  markNotified(sessionId: string): void;
}

export interface ExitFlushDeps {
  store: ExitFlushStore;
  /** 杀整组（pid 缺失 / 已退静默吞错）。 */
  killProcessGroup: (pid: number | undefined, signal: NodeJS.Signals) => void;
  /** 终态 relay with retry（= host 的 relayEventsWithRetry，带 timeout）。 */
  relayWithRetry: (
    owner: PersistedEntryOwner | undefined,
    threadId: string,
    events: RelayEvent[],
    opts?: { timeoutMs?: number },
  ) => Promise<void>;
  log: TerminalRelayLogger;
  /** 构造终态 events（默认真实实现；测试可注入）。 */
  buildEvents?: typeof defaultBuildBackgroundTaskTerminalResult;
  /** 时钟（默认 Date.now；测试注入）。 */
  now?: () => number;
  /** relay send 上限（默认 2.5s）。 */
  relayTimeoutMs?: number;
  /** SIGKILL 兜底前的宽限（默认 2s）。 */
  graceMs?: number;
  /**
   * A4：调度 SIGKILL 兜底（**fire-and-forget，不 await**）。默认 `setTimeout`。
   * 注入让测试可手动驱动 / 断言不阻塞退出链。
   */
  scheduleSigkill?: (fn: () => void, ms: number) => void;
  /** 日志前缀（'electron' / 'daemon'）。 */
  hostLabel?: string;
}

/**
 * 退出路径（终端假运行根治 v3 路线 A / F-EXIT）：客户端 / daemon 整体退出时，对所有
 * **本地后台 shell 命令** = 全部取消，并**同步 flush**"已终止(app_exit)"终态到 Django
 * （发不出去落 RelayRetryQueue 等下次启动 recover），从源头消灭优雅退出场景的假运行
 * ——不依赖 Layer 2 启动对账。两端 host 共用本实现（A1 单测 + A2 对称）。
 *
 * 步骤（顺序即不变量，**勿在 1→2 之间插 await**，详见各步注释）：
 *   1. **先同步 seal 所有 running record**（updateOnExit app_exit + markNotified）；
 *   2. **同步** SIGTERM 整组；
 *   3. **await** 构造 + flush 终态（每条独立 timeout，超时落盘）；
 *   4. **fire-and-forget** 宽限 → SIGKILL 整组兜底（A4：不 await 阻塞退出链）。
 */
export async function runBackgroundTaskExitFlush(deps: ExitFlushDeps): Promise<void> {
  const buildEvents = deps.buildEvents ?? defaultBuildBackgroundTaskTerminalResult;
  const now = deps.now ?? (() => Date.now());
  const relayTimeoutMs = deps.relayTimeoutMs ?? 2_500;
  const graceMs = deps.graceMs ?? 2_000;
  const scheduleSigkill = deps.scheduleSigkill ?? ((fn, ms) => { setTimeout(fn, ms); });
  const tag = deps.hostLabel ? `[exit-flush:${deps.hostLabel}]` : '[exit-flush]';

  const running = deps.store.list().filter((r) => r.status === 'running');
  if (running.length === 0) return;

  deps.log.info?.(`${tag} stopping ${running.length} running background command(s) (route A = cancel on quit)`);

  // ════════════════════════════════════════════════════════════════════
  // 不变量①【seal-then-kill，且 seal 必须在第一个 await 之前完成】
  //
  // 先**同步**把所有 running record 封成 killed(app_exit) + markNotified——必须发生在
  // 任何 kill / relay / await **之前**。这样被杀进程触发的 bridge `handle.result.then`
  // 里的 `updateOnExit`（record 已非 running → 幂等 no-op）与 `emitPushNotificationOnExit`
  // （killed_reason==='app_exit' → 提前 return）都不会再投一条"真实 exit_code"终态，消除"退出
  // flush 的 app_exit 与自然 exit 的 completed 双写、Django 后写覆盖导致重载显示成功/
  // 退出码"的竞态（技术正确性 review P1）。
  //
  // ⚠️【防回归红线】本 seal 循环到下面 SIGTERM 之间**严禁插入任何 await**。一旦有人
  // 在中间加一句 await，事件循环让位 → 被杀进程的 exit handler 可能在"部分 record 已
  // seal、部分未 seal"时跑，重新引入双写竞态。`terminal-state-relay.test.ts` 有显式
  // 防回归用例（旧用例只断言顺序；新增「A1 强化」用微任务探针**真正抓 await 插入** +
  // 在 relay 异步窗口内并发触发自然 exit handler 验证不双写）。
  //
  // 注意：这条"零 await"是 **defense-in-depth**。**根本护栏其实是
  // `updateOnExit` 幂等 + app_exit producer no-op**——即便同步段被破坏、exit handler 在 flush
  // 异步窗口内并发触发 `updateOnExit(completed)`，record 已 seal 成 killed(app_exit)
  // 会让那条 completed 被幂等吞掉（不覆盖、不二次推送）。两道一起兜，缺一不致命但都要在。
  // ════════════════════════════════════════════════════════════════════
  for (const r of running) {
    deps.store.updateOnExit(r.session_id, {
      status: 'killed',
      exit_code: -1,
      exited_by: 'signal',
      killed_reason: 'app_exit',
    });
    deps.store.markNotified(r.session_id);
  }

  // 2. SIGTERM 整组（仍在第一个 await 之前——保持 seal-then-kill 同步段完整）。
  for (const r of running) deps.killProcessGroup(r.pid, 'SIGTERM');

  // 3. 构造 + 同步 flush "已终止(app_exit)" 终态（route A）。并行，每条独立 await——
  //    退出窗口脆弱：给 send 一个 relayTimeoutMs 上限，超时即落盘等下次启动 recover。
  await Promise.allSettled(
    running.map(async (r) => {
      if (!r.threadId) {
        // F7 拦住了新 spawn，这里只可能命中历史脏 record——记 warn，靠 Layer 2 兜底。
        deps.log.warn(
          `${tag} record ${r.session_id.slice(0, 8)}… has no threadId; terminal state not relayed (rely on Layer 2 / startup reconcile)`,
        );
        return;
      }
      try {
        const events = buildEvents({
          threadId: r.threadId,
          input: {
            agent_session_id: r.session_id,
            tool_use_id: r.toolUseId,
            command: r.command,
            exit_code: null,
            exited_by: 'signal',
            killed_reason: 'app_exit',
            status: 'killed',
            duration_ms: Math.max(0, now() - r.started_at),
            output_file_path: r.output_file_path,
            cwd: r.cwd,
          },
        });
        if (events) {
          await deps.relayWithRetry(r.owner, r.threadId, events as RelayEvent[], { timeoutMs: relayTimeoutMs });
        }
      } catch (err) {
        deps.log.warn(
          `${tag} relay terminal state failed session=${r.session_id.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  // 4. A4：宽限 → SIGKILL 整组兜底**改为 fire-and-forget**——不 await 阻塞退出链。
  //    退出链下游（flushSiteAccessMemory / destroyPtyManager / 窗口 beforeunload 的
  //    PTY 快照保存）与本宽限并发跑，避免叠加 relay 上限吃满 CLEANUP_TIMEOUT 被硬截断
  //    （A4 预算解耦）。SIGTERM 已发出，宽限期内进程多半已退；残留 detached 子孙由
  //    SIGKILL（宽限到点）/ OS control-group / Layer 2 启动对账兜底。
  scheduleSigkill(() => {
    for (const r of running) deps.killProcessGroup(r.pid, 'SIGKILL');
  }, graceMs);
}
