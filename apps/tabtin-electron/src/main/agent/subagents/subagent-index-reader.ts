/**
 * subagent-index-reader — 读父 session 的 `subagents.jsonl` 索引，聚合出
 * 一份 `SubagentRunSnapshot[]`，供 renderer 加载历史会话时灌入
 * `subagentRunsBySessionId`，让"状态同步中"的卡片能恢复真实状态。
 *
 * **为什么需要这个文件**
 *
 * SUBAGENT_STARTED / SUBAGENT_PROGRESS / SUBAGENT_COMPLETED 这些事件通过
 * `context.emitStreamEvent` 同步发出，绕过了主 generator 循环，所以：
 *   - **父 events.jsonl** 不记录（events.jsonl 只写 generator yield 的事件）
 *   - **父 messages.jsonl** 不记录（`_isPersistableEnvelope` 白名单只放
 *     6 件套 + lifecycle + compaction）
 *
 * 实时路径下 renderer 通过 IPC `agent-engine:stream-event` 收到事件后写
 * `subagentRunsBySessionId`，卡片正常显示；但用户刷新页面 / 切走再回 /
 * 重启 Electron 时，runtime store 不持久化 → 历史回放完全没数据 →
 * `ToolUseBlockView::SubagentBlockEntry` 反查 store miss → status 兜底
 * `'unknown'` → 卡片显示「状态同步中」+ 隐藏 drill-in 按钮。
 *
 * **subagents.jsonl 是 SSoT**
 *
 * SubagentIndexWriter（packages/agent-runtime/src/session/subagent-index.ts）
 * 在子 Agent 起跑（phase=started）和收尾（phase=ended）时各 append 一行，
 * 字段包含 status / parentToolCallId / task / startedAt / endedAt / durationMs / runSeq。
 * 本 reader 通过 runtime 的 resume-aware `foldSubagentRuns`（按 subSessionId + 最新
 * runSeq 折叠）聚合 → SubagentRunSnapshot，与 W4a `check_agent_id` 同源同算法。
 *
 * **路径解析铁律**
 *
 * 与 subagent-session-reader 同款 safeRoot 防护：解析出的绝对路径必须在
 * `safeRoot` 子树内，防止被篡改的索引引发 path traversal。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { foldSubagentRuns } from '@tabtin/agent-runtime'
import type { SubagentIndexEntry } from '@tabtin/agent-runtime'

/**
 * 与 `SubagentRun`（renderer 端 chat/types.ts）形态对齐的"归档快照"。
 *
 * 不含运行时态字段（`toolHistory` / `latestTool` / `stepCount` / `latestToolStatus`）—
 * 这些字段只在 SUBAGENT_PROGRESS 事件流里有，索引文件不持久化；用户展开历史
 * 卡片时这些字段为空是可接受的（聚焦点是"状态/任务/耗时"先恢复，而不是
 * 完整重放每一步工具调用）。
 *
 * `summary` / `errorKind` / `timeoutMs` 同理 ——`subagents.jsonl` 不存这些字段，
 * 历史回放下保持空。未来如需要可以从子 events.jsonl 末尾解析 SUBAGENT_COMPLETED
 * payload 恢复（成本：每条 run 多读一次子 events.jsonl），现阶段先不做。
 */
export interface SubagentRunSnapshot {
  subagentRunId: string
  parentToolCallId?: string
  task?: string
  label?: string
  /**
   * Group/Mission：子 Agent 角色名（started 行的 `role`）。归档重建 chip 用——
   * 实时路径 chip 读 SUBAGENT_STARTED.speaker.role，重启 / 刷新后实时态丢失，
   * 这里从 subagents.jsonl 恢复，避免 chip 回落「子 Agent · 短id」。
   */
  role?: string
  /** 子 Agent 实际使用的模型（started 行 `model`），历史回看卡片展示用。 */
  model?: string
  childThreadId?: string
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt?: number
  endedAt?: number
  error?: string
  stats?: {
    duration_ms?: number
  }
}

export type ListSubagentRunsResult =
  | { ok: true; runs: SubagentRunSnapshot[] }
  | { ok: false; error: string }

export interface ListSubagentRunsInput {
  /**
   * 父 session 的根目录（譬如
   * `{dataRoot}/users/{userId}/organizations/{org}/workspaces/{ws}/conversations/sessions`）。
   * 由 caller 通过 `resolveWorkspaceSessionArchiveDir(dataRoot, userId, orgId, workspaceId)` 拼出后传入。
   */
  parentSessionDir: string
  parentSessionId: string
  /**
   * 安全沙箱根——`parentSessionDir` 必须在 safeRoot 子树内，防止被篡改的
   * 上游参数引发 path traversal（生产路径传 `resolveDataRoot()`）。
   */
  safeRoot: string
  /**
   * 单次最多返回多少条 run（按时序后裁剪，与 SubagentRun store 200 条 cap 对齐）。
   * 默认 200。
   */
  maxRuns?: number
}

export const DEFAULT_MAX_RUNS = 200

const RUN_STATUSES: ReadonlySet<SubagentRunSnapshot['status']> = new Set([
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])

function isWithinSafeRoot(target: string, safeRoot: string): boolean {
  const targetAbs = path.resolve(target)
  const safeRootAbs = path.resolve(safeRoot)
  return targetAbs === safeRootAbs || targetAbs.startsWith(safeRootAbs + path.sep)
}

/**
 * `foldSubagentRuns` 直接采信 ended 行的 `status`（不校验），磁盘损坏 / 手改索引时
 * 非法 status 串可能穿透到此。这里兜一道：非法值降级为 'running'（"最后已知态"），
 * 与旧 reader 的诚实降级语义一致——不把脏 ended 假装成 'completed'，也避免把非法
 * 枚举值灌进 renderer。
 */
function normalizeStatus(s: string): SubagentRunSnapshot['status'] {
  return RUN_STATUSES.has(s as SubagentRunSnapshot['status'])
    ? (s as SubagentRunSnapshot['status'])
    : 'running'
}

/**
 * 列出父 session 派出过的所有子 Agent run。
 *
 * 失败原因（与 subagent-session-reader 同款枚举集）：
 * - `path_traversal_detected`：`parentSessionDir` 不在 `safeRoot` 子树内
 * - `subagents_index_missing`：`subagents.jsonl` 不存在（此 session 从未派过子 Agent）
 * - `read_failed:{detail}`：文件读取报错
 *
 * **行级宽容**：单条 line 解析失败 / 字段不全只 silent skip，不让整体读取失败——
 * 历史 schema 演进 / 磁盘坏块都不应该让"剩下的好数据"也读不出来。
 */
export async function listSubagentRunsForSession(
  input: ListSubagentRunsInput,
): Promise<ListSubagentRunsResult> {
  const { parentSessionDir, parentSessionId, safeRoot, maxRuns = DEFAULT_MAX_RUNS } = input

  const parentSessionAbsDir = path.resolve(path.join(parentSessionDir, parentSessionId))
  if (!isWithinSafeRoot(parentSessionAbsDir, safeRoot)) {
    return { ok: false, error: 'path_traversal_detected' }
  }

  const indexPath = path.join(parentSessionAbsDir, 'subagents.jsonl')
  if (!fs.existsSync(indexPath)) {
    return { ok: false, error: 'subagents_index_missing' }
  }

  let raw: string
  try {
    raw = await fs.promises.readFile(indexPath, 'utf-8')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `read_failed:${detail}` }
  }

  // W5-b（2026-05-30）：折叠改用 runtime SSoT `foldSubagentRuns`（resume-aware）。
  //
  // 旧版按 childId 朴素 last-write-wins 折叠：resume 续跑（同 childId、runSeq+1）后，
  // 若最新 run 起跑但未结束 / 崩溃，会保留**上一 run** 的 `completed`，把仍在跑的
  // 孤儿误判成「已完成」。改走 `foldSubagentRuns` 后按 (subSessionId, max(runSeq)) 取
  // 最新 run，孤儿如实呈现 `running`，且与 W4a check_agent_id 完全同源同算法。
  //
  // 行级宽容解析成 SubagentIndexEntry[]（坏行 skip）；foldSubagentRuns 内部对缺字段 /
  // 缺 runSeq 已向后兼容（视为 1）。childThreadId 仍取 started 行的 paths.sessionDir
  // （同一 subSession 各 run 不变），fold 结果不带 paths，故单独建表回填。
  const entries: SubagentIndexEntry[] = []
  const sessionDirBySubSession = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let entry: SubagentIndexEntry
    try {
      entry = JSON.parse(t) as SubagentIndexEntry
    } catch {
      continue
    }
    entries.push(entry)
    if (
      entry.phase === 'started' &&
      typeof entry.subSessionId === 'string' &&
      typeof entry.paths?.sessionDir === 'string'
    ) {
      sessionDirBySubSession.set(entry.subSessionId, entry.paths.sessionDir)
    }
  }

  // foldSubagentRuns 已按 createdAt 升序；这里只做字段映射 + maxRuns 尾裁剪
  // （与 store 的 push-then-slice(-200) 一致——保留时序更近的）。
  const folded = foldSubagentRuns(entries)
  const runs: SubagentRunSnapshot[] = folded.map((run) => ({
    subagentRunId: run.childId,
    parentToolCallId: run.parentToolCallId,
    task: run.task,
    label: run.label,
    role: run.role,
    model: run.model,
    childThreadId: sessionDirBySubSession.get(run.subSessionId),
    status: normalizeStatus(run.status),
    startedAt: run.createdAt,
    endedAt: run.endedAt,
    error: run.errorMessage,
    stats: typeof run.durationMs === 'number' ? { duration_ms: run.durationMs } : undefined,
  }))
  const trimmed = runs.length > maxRuns ? runs.slice(-maxRuns) : runs

  return { ok: true, runs: trimmed }
}
