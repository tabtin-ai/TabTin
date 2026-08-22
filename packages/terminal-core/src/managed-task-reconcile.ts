/**
 * Layer 2 启动对账纯核心（终端假运行根治 v3 / 治 F9：host 崩溃兜底）。
 *
 * **范围**（PRD §5 Layer 2，已被 Wave 1 缩小）：只兜 **崩溃 / 断电 / `kill -9`**——
 * 清理链路（退出守卫 `runBackgroundTaskExitFlush`）没机会跑、内存 `ManagedTaskStore`
 * 整个蒸发这一种残余。优雅退出已被 Wave 1 退出 flush 覆盖，**不在此重复造**。
 *
 * **为什么抽纯核心**：与 `terminal-state-relay.ts`（Wave 1 退出 flush）同款思路——
 * 两端 host（Electron / Daemon）是数千行重副作用巨类，jsdom / node vitest 无法 import。
 * 把"探活 → 读 sidecar → 判定终态 → 回写"算法抽成依赖注入的纯函数，I/O（探 pid /
 * 读 sidecar / relay / 删盘 / 时钟）全部由调用方注入，核心就能脱离 host 充分单测，
 * 两端 host 退化成薄 wrapper（注入 `process.kill(pid,0)` / `fs` / Wave 1 的
 * `relayEventsWithRetry`）。本模块对 electron / node-pty / agent-runtime **零依赖**。
 *
 * **判定真相源优先级**（每轮探活循环）：
 *   1. **sidecar 在 = 最强真相源**（磁盘 footer / `exited()` 真相源）：命令已写
 *      退出码 → 直接采信，**哪怕 pid 还"活着"**（极可能是 OS 重用了同 pid 的无关新
 *      进程，绝不去 kill / 等它）。
 *   2. **pid 没了（或无 pid）** → 再读一次 sidecar（race：刚写完才死）→ 否则诚实 unknown。
 *   3. **pid 重用防护**：pid 活着但 `output_file` 已不在 → 几乎可断定是被重用的 pid，
 *      不是我们的命令 → 保守标 unknown，绝不轮询 / 误判同 pid 新进程。
 *   4. **轮询超预算**（默认 record.hard_timeout_ms 或 12h）→ 放弃，诚实 unknown。
 *   5. **命令确实还在跑**（崩溃后 detached 子进程仍存活）→ 轮询探活，探到结束再回写。
 *
 * **unknown 的诚实表达**（review 修正）：`exit_code: null` + `status: 'unknown'` +
 * `exited_by: 'normal_exit'`。前端 `TerminalCard` 对 `status:'unknown'` 已有**中性灰
 * 「运行状态未知」**渲染（Layer 3 已落地），既让卡片**停止转圈**，又**不假装成功 /
 * 失败 / 被杀**（对齐 footer "exited (unknown)"）。⚠️ `exited_by` 必须用
 * `normal_exit` 而非 `signal`——前端 `deriveStatusFromStructuredFields` 把
 * `exited_by==='signal'` 短路成红色「已终止」，会**先于** `status` 判定（会盖掉 unknown），
 * 故这里用 normal_exit 让 `status:'unknown'` 生效（status 才是真正的信号）。
 */

import * as fs from 'node:fs';
import type { ExitedBy, KilledReason, ManagedTaskOwner } from './managed-task-store';

/** 轮询探活间隔（毫秒）。崩溃后 detached 命令可能还要跑很久，5s 一探足够、开销可忽略。 */
export const DEFAULT_RECONCILE_POLL_INTERVAL_MS = 5_000;

/** 轮询总预算（毫秒）。超此仍没探到结束 → 放弃标 unknown。默认 12h，与 hard_timeout 兜底对齐。 */
export const DEFAULT_RECONCILE_POLL_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** 对账所需的 record 子集（`PersistedManagedTask` 的结构化**窄化/子集**，解耦反向依赖）。 */
export interface ManagedTaskReconcileRecord {
  session_id: string;
  pid?: number;
  toolUseId: string;
  threadId?: string;
  command: string;
  cwd: string;
  output_file_path: string;
  statusfile_path?: string;
  owner?: ManagedTaskOwner;
  started_at: number;
  /** LLM 传的命令真死线（毫秒）——作为本条 record 的轮询预算上限；缺省走 deps.pollTimeoutMs。 */
  hard_timeout_ms?: number;
}

/** 对账判定出的终态（交给 host 构造终态 events + 走 Wave 1 relay outbox 回写）。 */
export interface ReconcileTerminalState {
  exit_code: number | null;
  exited_by: ExitedBy;
  /** `unknown` = sidecar 不可用的诚实降级（前端渲染中性灰「运行状态未知」）。 */
  status: 'completed' | 'killed' | 'failed' | 'unknown';
  killed_reason?: KilledReason;
  /**
   * 估算耗时（毫秒）。崩溃后真实结束时刻不可知，取 `max(0, now - started_at)`
   * 上界——纯展示用，前端不据此判定。
   */
  duration_ms: number;
  /** true = sidecar 缺失 / 损坏 / 探活超预算导致的诚实 unknown（exit_code:null）。 */
  unknown: boolean;
}

export type ReconcileOutcome = 'relayed_exit' | 'relayed_unknown' | 'skipped';

export interface ManagedTaskReconcileDeps {
  /** `process.kill(pid, 0)` 探活：缺省走 `isProcessAlive`（测试可注入 fake）。 */
  isPidAlive?: (pid: number | undefined) => boolean;
  /** 读 sidecar statusfile 退出码：缺省走 `readSidecarExitCode`（测试可注入 fake）。 */
  readSidecarExitCode?: (statusfilePath: string | undefined) => number | null;
  /** `output_file` 是否仍存在（pid 重用防护）：缺省 `fs.existsSync`（测试可注入 fake）。 */
  outputFileExists?: (outputFilePath: string) => boolean;
  /** 走 Wave 1 outbox 回写终态（host：构造 events + `relayEventsWithRetry`）。best-effort（host 内吞错）。 */
  relayTerminalState: (
    record: ManagedTaskReconcileRecord,
    terminal: ReconcileTerminalState,
  ) => Promise<void> | void;
  /** 收尾：从盘上删 record（防下次重复对账）+ 清 sidecar。best-effort。 */
  finalizeCleanup: (record: ManagedTaskReconcileRecord) => Promise<void> | void;
  log: { info?: (m: string) => void; warn: (m: string) => void };
  /** 时钟（默认 Date.now；测试注入）。 */
  now?: () => number;
  /** 轮询等待（默认 setTimeout + unref；测试注入可控 sleep 驱动循环）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 轮询间隔（默认 5s）。 */
  pollIntervalMs?: number;
  /** 轮询总预算（默认 12h；record.hard_timeout_ms 存在时优先）。 */
  pollTimeoutMs?: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shortId(sessionId: string): string {
  return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId;
}

/**
 * `process.kill(pid, 0)` 探活默认实现：true=存活 / false=没了 / 无 pid。
 * EPERM（进程存在但无权限发信号）仍算存活。两端 host 共用（避免逐字重复）。
 */
export function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读 sidecar statusfile 退出码默认实现：整数 / null（缺失 / 空 / 非整数 = 损坏）。两端 host 共用。 */
export function readSidecarExitCode(statusfilePath: string | undefined): number | null {
  if (!statusfilePath) return null;
  try {
    const raw = fs.readFileSync(statusfilePath, 'utf8').trim();
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** `output_file` 是否仍存在默认实现（pid 重用防护）。空路径视为不存在。 */
export function outputFileExistsDefault(outputFilePath: string): boolean {
  try {
    return !!outputFilePath && fs.existsSync(outputFilePath);
  } catch {
    return false;
  }
}

/**
 * exit code → 终态分类（与 bridge exit handler / `deriveBackgroundTaskStatus` 同源）。
 *   - 126/127：command not found / not executable → exec_failure / failed；
 *   - 129..159（128+signal，如 SIGKILL=137 / SIGTERM=143）：被信号杀 → signal / killed
 *     （与 live 路径口径一致，不把"被杀"说成"完成"）；
 *   - 其余：normal_exit / completed（成功 0 / 失败非 0 由 exit_code 体现）。
 */
function classifyExit(exitCode: number, now: number, startedAt: number): ReconcileTerminalState {
  if (exitCode === 126 || exitCode === 127) {
    return { exit_code: exitCode, exited_by: 'exec_failure', status: 'failed', duration_ms: Math.max(0, now - startedAt), unknown: false };
  }
  if (exitCode >= 129 && exitCode <= 159) {
    return { exit_code: exitCode, exited_by: 'signal', status: 'killed', duration_ms: Math.max(0, now - startedAt), unknown: false };
  }
  return { exit_code: exitCode, exited_by: 'normal_exit', status: 'completed', duration_ms: Math.max(0, now - startedAt), unknown: false };
}

/**
 * sidecar 不可用 → 诚实 unknown。`status:'unknown'`（前端中性灰「运行状态未知」）+
 * `exited_by:'normal_exit'`（避免前端 signal 短路成红色「已终止」盖掉 unknown）。
 */
function classifyUnknown(now: number, startedAt: number): ReconcileTerminalState {
  return {
    exit_code: null,
    exited_by: 'normal_exit',
    status: 'unknown',
    duration_ms: Math.max(0, now - startedAt),
    unknown: true,
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

/**
 * 对账单条残留 running record（崩溃前在跑的后台命令）。判定真相源优先级见模块头注释。
 *
 * **长跑语义**：命中"命令仍在跑"分支时本 Promise 会一直轮询到命令结束 / 超预算才
 * resolve（可能数小时）——调用方应 fire-and-forget（`void`），不阻塞 host 启动；
 * 内部 sleep 默认 unref，不阻塞进程退出。
 */
export async function reconcileManagedTask(
  record: ManagedTaskReconcileRecord,
  deps: ManagedTaskReconcileDeps,
): Promise<ReconcileOutcome> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const isPidAlive = deps.isPidAlive ?? isProcessAlive;
  const readSidecar = deps.readSidecarExitCode ?? readSidecarExitCode;
  const outputFileExists = deps.outputFileExists ?? outputFileExistsDefault;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_RECONCILE_POLL_INTERVAL_MS;
  // 预算从**命令出生**（started_at）起算，而非对账起点——这把 PRD §5「started_at +
  // output_file 时间窗」的 started_at 维度落地：崩溃前已跑很久的命令对账剩余预算更短，
  // 收窄"sidecar 缺失 + pid 被重用"时轮询无关进程的假运行窗口；并让 hard_timeout_ms
  // 回归"命令死线"单一语义（超死线的孤儿直接判 unknown，不再额外多轮询一个完整周期）。
  const pollTimeoutMs =
    record.hard_timeout_ms ?? deps.pollTimeoutMs ?? DEFAULT_RECONCILE_POLL_TIMEOUT_MS;

  const finalize = async (terminal: ReconcileTerminalState): Promise<ReconcileOutcome> => {
    try {
      await deps.relayTerminalState(record, terminal);
    } catch (err) {
      deps.log.warn(`[layer2-reconcile] relay failed session=${shortId(record.session_id)}: ${errMsg(err)}`);
    }
    try {
      await deps.finalizeCleanup(record);
    } catch (err) {
      deps.log.warn(`[layer2-reconcile] cleanup failed session=${shortId(record.session_id)}: ${errMsg(err)}`);
    }
    return terminal.unknown ? 'relayed_unknown' : 'relayed_exit';
  };

  for (;;) {
    // 1. sidecar 在 = 最强真相源（命令已写退出码），直接采信。
    const exitCode = readSidecar(record.statusfile_path);
    if (exitCode !== null) {
      return finalize(classifyExit(exitCode, now(), record.started_at));
    }
    // 2. pid 没了（或无 pid）→ race 复读 sidecar → 否则诚实 unknown。
    if (!isPidAlive(record.pid)) {
      const exitCodeAfter = readSidecar(record.statusfile_path);
      if (exitCodeAfter !== null) {
        return finalize(classifyExit(exitCodeAfter, now(), record.started_at));
      }
      return finalize(classifyUnknown(now(), record.started_at));
    }
    // 3. pid 重用防护：pid 活着但 output_file 不在 → 大概率被重用的 pid → 保守 unknown。
    if (!outputFileExists(record.output_file_path)) {
      return finalize(classifyUnknown(now(), record.started_at));
    }
    // 4. 轮询超预算（从命令出生 started_at 起算）→ 放弃，诚实 unknown（Layer 2 不杀孤儿，只恢复终态）。
    if (now() - record.started_at >= pollTimeoutMs) {
      deps.log.warn(`[layer2-reconcile] poll timeout session=${shortId(record.session_id)} → unknown`);
      return finalize(classifyUnknown(now(), record.started_at));
    }
    // 5. 命令确实还在跑 → 等一拍再探（非 re-attach：Node 重启后无 ChildProcess 句柄）。
    await sleep(pollIntervalMs);
  }
}

/**
 * 批量对账（host 启动时一次性把上次进程残留的 running record 全部对账）。
 *
 * 返回每条的 outcome（顺序对齐入参）；某条 reconcile 抛错 → `'skipped'`。注意"命令
 * 仍在跑"的条目会让返回 Promise 一直 pending 到命令结束——调用方应 `void` 掉。
 */
export async function reconcileManagedTasks(
  records: ManagedTaskReconcileRecord[],
  deps: ManagedTaskReconcileDeps,
): Promise<ReconcileOutcome[]> {
  const settled = await Promise.allSettled(records.map((r) => reconcileManagedTask(r, deps)));
  return settled.map((s) => (s.status === 'fulfilled' ? s.value : 'skipped'));
}
