/**
 * pending-single-hitl-restorer —  单 HITL 断点恢复。
 *
 * 与 `pending-approvals-restorer` 对称，处理 ask_choice / ask_form /
 * permission_request 这三类**单 HITL 交互**在 runtime 崩溃后的恢复。
 *
 * 状态流：
 * - `resolved`：用户已答复 → 合成 tool_result inject（`is_error=true` 标恢复态）。
 * - `pending` 未过期 → 通过 `InterruptPort.interrupt` 重挂 wire 卡片等新答复。
 * - `pending` 已过 `expires_at` / `expired` / `cancelled` → 兜底终态文案。
 *
 * **Pairing 约束（P0 修复口径，禁止 fail-soft）**：restorer inject 的 tool_result
 * 必须能与 `state.messages` 里的 assistant tool_use 配对，否则会被 `ensureToolResultPairing.
 * dropOrphanToolResults` 丢弃 = 「用户答复被静默忽略」。挂起前的 assistant
 * partial persist（`ask-tools.ts::persistCurrentAssistantForHitlResume`）保证
 * 常态可配对；本 restorer 消费 `payload.tool_use_id`（LLM 生成的 `tool_use.id`）
 * 作为 `tool_result.tool_use_id`，与 assistant 里的块严格对齐。若上游没透
 * 传 `tool_use_id`（旧宿主 / 测试 stub / 早期 pending 行），fallback 到
 * `requestKey`；此时若 `state.messages` 无匹配 tool_use，restorer 会 fail-loud
 * （`onLog('warn')` + 在返回值里标记 unpairedRequestKeys），调用方可断言。
 */

import type {
  ToolResultBlock,
} from '../engine/contracts/conversation.js';
import type {
  SerializedPendingSingleHitl,
} from '../engine/contracts/hitl.js';
import type {
  StreamEvent,
} from '../engine/contracts/wire-protocol.js';
import {
  AskRequiredEvent,
  HITL_KIND_TO_ASK_EVENT_TYPE,
} from '../event/events/hitl-events.js';
import {
  HITL_TOOL_LABEL_BY_KIND,
  asRecord,
  describeResultSummary,
  quote,
  truncate,
} from './hitl-result-format.js';

// ─── Public API ──────────────────────────────────────────────────────

/**
 * 挂起原语：与 `emitAndWait` 一致的最小切面（避免 restorer 反向依赖
 * `interrupt-adapter` 具体实现）。
 */
export interface PendingSingleHitlInterrupt {
  isAvailable(): boolean;
  interrupt<T = unknown>(req: {
    kind: 'ask_user' | 'ask_form' | 'request_approval';
    interruptId: string;
    requestEvent?: StreamEvent;
    timeoutMs?: number;
  }): Promise<{ status: 'resolved'; value: T } | { status: 'timeout'; message: string }>;
}

export interface PendingSingleHitlRestoreInput {
  pendingSingleHitl: SerializedPendingSingleHitl[];
  /** 挂起等待原语——由 `interrupt-adapter` 注入，与 emitAndWait 走同一条路。 */
  interrupt: PendingSingleHitlInterrupt;
  /** 事件出口——重挂 pending 时用于兜底 emit（当 interrupt.isAvailable=false）。 */
  emitStreamEvent?: (event: StreamEvent) => void;
  /**
   * 已知 assistant tool_use.id 集合（== `state.messages` 里所有 assistant blocks
   * 里 `tool_use.id` 的并集）。restorer 用它做 pairing 校验：inject 的每条
   * tool_result 的 `tool_use_id` 都必须在集合里，否则 fail-loud（`unpairedRequestKeys`
   * + `onLog('warn')`）。
   *
   * 缺省 `undefined` 时跳过校验（用于 restorer 单测独立运行；生产链路
   * `run-prelude-phases.ts::restorePendingApprovalsPhase` 会传入）。
   */
  knownAssistantToolUseIds?: Set<string>;
  /** 测试 / 排障日志钩子。 */
  onLog?: (level: 'info' | 'warn', message: string) => void;
}

export interface PendingSingleHitlRestoreResult {
  /**
   * 注入到 `state.messages` 的 tool_result blocks（按 requestKey 顺序）。
   * 调用方包装成一条 `{ role: 'user', content: blocks }` message append。
   *
   * `block.tool_use_id` 取自 `entry.payload.tool_use_id`（LLM 生成的
   * `tool_use.id`，与 assistant 里的 tool_use 直接配对）；缺席时 fallback
   * 到 `requestKey` 让整块保留形态（记入 `unpairedRequestKeys`，交调用方处置）。
   */
  toolResultBlocks: ToolResultBlock[];
  restoredRequestKeys: string[];
  rehangedRequestKeys: string[];
  injectedTerminalKeys: string[];
  /**
   * pairing 校验失败的 requestKey（inject 的 tool_result.tool_use_id 不在
   * `knownAssistantToolUseIds` 里）。生产链路应为空——非空即意味着挂起前
   * 的 partial persist 没跑到 / assistant 落库时丢了 tool_use，属于 P0 修复
   * 漏网，需要报警。
   */
  unpairedRequestKeys: string[];
}

const HITL_KIND_TO_EVENT_TYPE = HITL_KIND_TO_ASK_EVENT_TYPE;

/**
 * 单 HITL 挂起等待默认超时（与 ask-tools 里 ASK_USER_TIMEOUT_MS 对齐 = 30min）。
 * 集中定义避免"魔法数字散落"（TabTin engineering 规约）。
 */
const SINGLE_HITL_RESUME_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function createResult(): PendingSingleHitlRestoreResult {
  return {
    toolResultBlocks: [],
    restoredRequestKeys: [],
    rehangedRequestKeys: [],
    injectedTerminalKeys: [],
    unpairedRequestKeys: [],
  };
}

function isEntryExpired(entry: SerializedPendingSingleHitl, nowMs: number): boolean {
  if (entry.status === 'expired' || entry.status === 'cancelled') return true;
  return Boolean(
    entry.expiresAt != null
    && Number.isFinite(entry.expiresAt)
    && entry.expiresAt > 0
    && entry.expiresAt < nowMs,
  );
}

/** 从 wire payload 里读 LLM `tool_use.id`；缺席时 fallback 到 requestKey。 */
function resolveToolUseIdForRestore(entry: SerializedPendingSingleHitl): string {
  const payload = asRecord(entry.payload);
  const raw = payload.tool_use_id;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  return entry.requestKey;
}

/**
 * 恢复主入口。单条 entry 处理失败按「兜底 terminal notice + warn」收口
 * （避免一条 bad entry 阻塞整批 resume）；orphan pairing 走 fail-loud
 * （见 `unpairedRequestKeys` + `onLog('warn')`），不静默丢。
 */
export async function applyPendingSingleHitlRestore(
  input: PendingSingleHitlRestoreInput,
): Promise<PendingSingleHitlRestoreResult> {
  const result = createResult();

  if (!input.pendingSingleHitl || input.pendingSingleHitl.length === 0) {
    return result;
  }

  const now = Date.now();

  for (const entry of input.pendingSingleHitl) {
    if (!entry || typeof entry !== 'object') continue;
    const key = entry.requestKey;
    if (!key) {
      input.onLog?.('warn', '[SingleHitlResume] skipping entry with empty requestKey');
      continue;
    }
    result.restoredRequestKeys.push(key);

    try {
      await restoreOneEntry({ entry, now, input, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      input.onLog?.('warn', `[SingleHitlResume] restore failed for ${entry.kind}/${key}: ${msg}`);
      appendTerminalBlock({
        entry,
        result,
        content: `[crash-resume] 恢复交互失败（${truncate(msg, 200)}），已按跳过处理。`,
      });
    }
  }

  // Pairing 校验（P0 修复 · fail-loud）：每条 inject 的 tool_result 都必须能
  // 与 `state.messages` 里的 assistant tool_use 对上，否则会被 dropOrphanToolResults
  // 静默丢——正是本 issue 要根治的漏点。
  if (input.knownAssistantToolUseIds) {
    const known = input.knownAssistantToolUseIds;
    for (const block of result.toolResultBlocks) {
      if (!known.has(block.tool_use_id)) {
        // requestKey 就是 block.tool_use_id 的兜底源；缺 tool_use_id 时两者相等，
        // 这里直接用 block.tool_use_id 标错，跟排障链路一致。
        result.unpairedRequestKeys.push(block.tool_use_id);
        input.onLog?.(
          'warn',
          `[SingleHitlResume] pairing failure: injected tool_result.tool_use_id=${block.tool_use_id} `
          + `not found in state.messages assistant tool_use blocks — this means the pre-await partial `
          + `persist did not fire before crash, or the assistant message was never persisted. `
          + `Restore result will be dropped as orphan by ensureToolResultPairing.`,
        );
      }
    }
  }

  return result;
}

interface RestoreOneEntryArgs {
  entry: SerializedPendingSingleHitl;
  now: number;
  input: PendingSingleHitlRestoreInput;
  result: PendingSingleHitlRestoreResult;
}

async function restoreOneEntry(args: RestoreOneEntryArgs): Promise<void> {
  const { entry, now, input, result } = args;

  // 1) 已终态（resolved）→ 直接按 result inject
  if (entry.status === 'resolved') {
    const block = buildResolvedToolResult(entry);
    result.toolResultBlocks.push(block);
    result.injectedTerminalKeys.push(entry.requestKey);
    return;
  }

  // 2) 已过期 / 已取消（含 pending 但 expires_at < now）→ inject 终态文案
  if (isEntryExpired(entry, now)) {
    const block = buildExpiredToolResult(entry);
    result.toolResultBlocks.push(block);
    result.injectedTerminalKeys.push(entry.requestKey);
    return;
  }

  // 3) 仍 pending 且未过期 → 重挂
  await rehangPendingEntry({ entry, input, result });
}

interface RehangArgs {
  entry: SerializedPendingSingleHitl;
  input: PendingSingleHitlRestoreInput;
  result: PendingSingleHitlRestoreResult;
}

async function rehangPendingEntry(args: RehangArgs): Promise<void> {
  const { entry, input, result } = args;

  if (!input.interrupt.isAvailable()) {
    input.onLog?.('warn', `[SingleHitlResume] interrupt unavailable for ${entry.kind}/${entry.requestKey}, fail-closed skip`);
    appendTerminalBlock({
      entry,
      result,
      content: '[crash-resume] 交互通道不可用，已按跳过处理。',
    });
    return;
  }

  const eventType = HITL_KIND_TO_EVENT_TYPE[entry.kind];
  const toolKind = HITL_TOOL_LABEL_BY_KIND[entry.kind];
  const payload = normalizePayloadForReemit(entry);
  const timeoutMs = computeRemainingTimeoutMs(entry);

  const outcome = await input.interrupt.interrupt({
    kind: toolKind,
    interruptId: entry.requestKey,
    requestEvent: new AskRequiredEvent(eventType, payload).toStreamEvent(),
    timeoutMs,
  });

  result.rehangedRequestKeys.push(entry.requestKey);

  if (outcome.status === 'resolved') {
    const block = buildResolvedToolResult({
      ...entry,
      status: 'resolved',
      result: outcome.value,
      resolvedAt: Date.now(),
    });
    result.toolResultBlocks.push(block);
    return;
  }

  // timeout / waiter reject
  input.onLog?.('warn', `[SingleHitlResume] rehang timeout for ${entry.kind}/${entry.requestKey}: ${outcome.message}`);
  appendTerminalBlock({
    entry,
    result,
    content: `[crash-resume] 等待用户答复超时（${truncate(outcome.message, 200)}），已按跳过处理。`,
  });
}

function computeRemainingTimeoutMs(entry: SerializedPendingSingleHitl): number {
  if (entry.expiresAt == null || !Number.isFinite(entry.expiresAt)) {
    return SINGLE_HITL_RESUME_DEFAULT_TIMEOUT_MS;
  }
  const remaining = entry.expiresAt - Date.now();
  return remaining > 0 ? remaining : SINGLE_HITL_RESUME_DEFAULT_TIMEOUT_MS;
}

function normalizePayloadForReemit(entry: SerializedPendingSingleHitl): Record<string, unknown> {
  const source = asRecord(entry.payload);

  // 保证核心 dedup 字段与原 emit 一致，避免前端因 request_id 不匹配把重挂
  // 卡片当作新一次请求（触发 dedup 缓存漂移）。
  return {
    ...source,
    request_id: source.request_id ?? entry.requestKey,
    ...(entry.expiresAt ? { expires_at: entry.expiresAt } : {}),
    ...(entry.runtimeMode ? { runtime_mode: entry.runtimeMode } : (source.runtime_mode ? {} : { runtime_mode: 'interactive' })),
  };
}

function appendTerminalBlock(args: {
  entry: SerializedPendingSingleHitl;
  result: PendingSingleHitlRestoreResult;
  content: string;
}): void {
  args.result.toolResultBlocks.push({
    type: 'tool_result',
    tool_use_id: resolveToolUseIdForRestore(args.entry),
    content: args.content,
    is_error: true,
  });
  args.result.injectedTerminalKeys.push(args.entry.requestKey);
}

// ─── tool_result 合成 ────────────────────────────────────────────────

/**
 * resolved entry → tool_result 文案。
 *
 * 尽量对齐 ask-tools 里 `formatAnsweredResult` / `formatAskFormResult` /
 * `formatSkippedResult` 的正向文案，让 LLM 在 restore 后收到与正常路径相同
 * 的信号（不需要额外解释 "why is this different from normal answer"）。
 *
 * 只处理三种主形态：
 *   1) `result.skipped === true` → 跳过文案
 *   2) `result.text` 非空 → 自由文本作答
 *   3) 其它 → 通用 "已收到用户回复：JSON dump"（对齐降级）
 *
 * 精细化的 answers / field_values 展开留给未来（tool-name 已丢，展开需要
 * question / field label 反查，restore 侧拿不到——写死 JSON dump 是可解释
 * 的降级）。
 */
function buildResolvedToolResult(entry: SerializedPendingSingleHitl): ToolResultBlock {
  const toolLabel = HITL_TOOL_LABEL_BY_KIND[entry.kind];
  const data = asRecord(entry.result);
  let content: string;
  if (data.skipped === true) {
    content = `[crash-resume] 用户跳过了本次 ${toolLabel} 请求，按无答案继续。`;
  } else if (typeof data.text === 'string' && data.text.trim()) {
    content = `[crash-resume] 用户已答复本次 ${toolLabel}：${quote(data.text)}。继续按用户答复推进。`;
  } else {
    const summary = describeResultSummary(entry.result);
    content = `[crash-resume] 用户已答复本次 ${toolLabel}：${summary}。继续按用户答复推进。`;
  }
  return {
    type: 'tool_result',
    tool_use_id: resolveToolUseIdForRestore(entry),
    content,
    // 与 pending-approvals-restorer 的 CRITICAL #2 修复同语义：restore 走 inject
    // 路径，工具本身并未再执行一次，标 is_error=true 让 LLM 感知这是恢复态而非
    // 正常成功输出——避免 LLM 拿 restore inject 当作 tool 的权威结果继续深度依赖。
    is_error: true,
  };
}

function buildExpiredToolResult(entry: SerializedPendingSingleHitl): ToolResultBlock {
  const toolLabel = HITL_TOOL_LABEL_BY_KIND[entry.kind];
  const suffix = entry.status === 'cancelled' ? '已被取消' : '已过期';
  return {
    type: 'tool_result',
    tool_use_id: resolveToolUseIdForRestore(entry),
    content: `[crash-resume] 本次 ${toolLabel} 请求${suffix}，按无答案继续。`,
    is_error: true,
  };
}

// ─── Wire decoder ────────────────────────────────────────────────────

/**
 * 把 wire `interrupt_state.pending_single_hitl[]`（snake_case）转成
 * runtime `SerializedPendingSingleHitl[]`（camelCase）。
 *
 * 与 `decodeWirePendingApprovals` 语义一致的 fail-soft：
 *   - 单条转换异常 / 必填字段缺失 → skip 该条 + warn（不抛）；
 *   - 未识别 status → 视为 `pending`；
 *   - 未识别 kind → skip 该条；
 *   - expires_at / created_at 非有限值 → undefined。
 */
export function decodeWirePendingSingleHitl(
  rawList: unknown,
  onLog?: (level: 'info' | 'warn', message: string) => void,
): SerializedPendingSingleHitl[] {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];

  const result: SerializedPendingSingleHitl[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const decoded = decodeOneEntry(r, onLog);
    if (decoded) result.push(decoded);
  }
  return result;
}

function decodeOneEntry(
  r: Record<string, unknown>,
  onLog?: (level: 'info' | 'warn', message: string) => void,
): SerializedPendingSingleHitl | null {
  const kind = decodeKind(r.kind);
  if (!kind) {
    onLog?.('warn', `[SingleHitlResume] decode: skipping entry with invalid kind=${String(r.kind)}`);
    return null;
  }
  const requestKey = typeof r.request_key === 'string' ? r.request_key : '';
  if (!requestKey) {
    onLog?.('warn', `[SingleHitlResume] decode: skipping ${kind} entry with empty request_key`);
    return null;
  }
  return {
    kind,
    requestKey,
    threadId: typeof r.thread_id === 'string' ? r.thread_id : undefined,
    status: decodeStatus(r.status),
    payload: r.payload,
    result: r.result,
    expiresAt: optionalFiniteNumber(r.expires_at),
    createdAt: optionalFiniteNumber(r.created_at),
    resolvedAt: optionalFiniteNumber(r.resolved_at),
    runtimeMode: decodeRuntimeMode(r.runtime_mode),
  };
}

function decodeKind(value: unknown): SerializedPendingSingleHitl['kind'] | null {
  return (value === 'ask_choice' || value === 'ask_form' || value === 'permission_request')
    ? value
    : null;
}

function decodeStatus(value: unknown): SerializedPendingSingleHitl['status'] {
  return (value === 'pending' || value === 'resolved' || value === 'expired' || value === 'cancelled')
    ? value
    : 'pending';
}

function decodeRuntimeMode(value: unknown): SerializedPendingSingleHitl['runtimeMode'] | undefined {
  return (value === 'interactive' || value === 'solo' || value === 'scheduled' || value === 'batch')
    ? value
    : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : undefined;
}

// 公共 helper 导出便于单测断言
export const __internal = {
  buildResolvedToolResult,
  buildExpiredToolResult,
  computeRemainingTimeoutMs,
  normalizePayloadForReemit,
  resolveToolUseIdForRestore,
  SINGLE_HITL_RESUME_DEFAULT_TIMEOUT_MS,
};
