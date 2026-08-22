/**
 * engine/contracts 第 6 层 —— 上下文治理与会话能力契约。
 *
 * Context Budget（集中阈值）+ Workspace Root helpers（FR-13）+
 * Compact System（CompactResult / SummaryReuse 家族 / AutoCompactParams）+
 * Session / Transcript（TranscriptEntry / SessionConfig）。
 *
 * 分层规则见 wire-protocol.ts 头注释；本层只允许 import 前 5 层。
 */

import type { Message } from './conversation.js';
import type { LLMRequest, LLMResponseChunk } from './model-llm.js';

// ─── Context Budget (centralized thresholds) ────────────────────────

export interface ContextBudget {
  /** Pressure threshold to trigger LLM compaction (default 0.85) */
  compactThreshold: number;
  /** Pressure threshold for emergency hard trim (default 0.95) */
  emergencyThreshold: number;
  /** Target pressure after compaction (default 0.70) */
  targetAfterCompact: number;
  /** Buffer tokens before compact threshold for warning state */
  warningBufferTokens: number;
  /** Buffer tokens before compact threshold for error state */
  errorBufferTokens: number;
  /** Reserve tokens below context window for blocking state */
  blockingReserveTokens: number;
  // W3 (2026-05-10): `condenseCooldownIterations` + `maxCondenseIterations`
  // removed alongside the auto-condense state machine they used to throttle.
  // auto-compact (`compact/auto-compact.ts`) now manages its own cadence via
  // `compactTracking`; runtime no longer asks the LLM to call
  // `summarize_context` so there's nothing left to time out.
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  compactThreshold: 0.85,
  emergencyThreshold: 0.95,
  targetAfterCompact: 0.70,
  warningBufferTokens: 20_000,
  errorBufferTokens: 10_000,
  blockingReserveTokens: 3_000,
};

// ─── Workspace Root helpers (FR-13 shared normalization) ─────────────
/**
 * 归一化宿主传入的 `workspaceRoot`。
 *
 * 两端宿主（Electron `getCLIOrganizationRoot()` / Daemon `DaemonConfig.workspace_root`）
 * 读出来的值可能是 `null`、`undefined` 或带空白字符的字符串。为避免：
 *
 * - `cwd: ""` 被 `child_process.exec` 在 Linux 上解释为 ENOENT；
 * - 尾空格/换行污染 `<identity>` 段文本；
 * - `null` 与 `undefined` 在 `EngineConfig.workspaceRoot`（类型 `string | undefined`）语义不一致。
 *
 * 统一在这里做 trim + 空串→undefined 的归一化，两端宿主都走它保持对称。
 * 输入若非字符串（比如宿主按 any 丢过来）也按 undefined 处理，不抛异常。
 *
 * @returns absolute path string, or `undefined` if input is not an absolute
 *   path (caller is responsible for absolutizing relative / `~`-prefixed
 *   inputs before calling — we deliberately avoid implicit `process.cwd()`
 *   resolution because host cwd ≠ organization root).
 */
export function normalizeWorkspaceRoot(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!trimmed.startsWith('/') && !trimmed.startsWith('\\') && !/^[A-Za-z]:/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

// ─── Compact System ─────────────────────────────────────────────────

/**
 * Compaction modes emitted by the Runtime.
 *
 * Grouping (by origin):
 * - `auto` — LLM summary via auto-compact (W1 删除自创 layered prune 后的中间档)。
 * - `native` — internal native compact used as intermediate layer inside compact.ts.
 * - `micro` — time-based microcompact in CompactionOrchestrator
 *   (清白名单工具的过期 tool_result 占位；W1 之前还含 query-deps 层
 *   "自创 micro 改写"的长度截断/dedup，已删除）。
 * - `reactive` — triggered by any tool emitting `signals.pendingCondense`
 *   via the orchestrator (no built-in producer after W3; `summarize_context`
 *   was the original consumer and is now removed).
 * - `emergency_blocking` — orchestrator's blocking guard after auto-compact failed.
 * - `recovery_413` — query.ts 413 error recovery path (compact then retry).
 * - `hard_trim` — query.ts fallback when 413 recovery compact itself fails.
 *
 * Any mode added here must also be mapped in the frontend `handleCompaction`
 * (see `miscHandler.ts`) — the TypeScript union guarantees both sides stay aligned.
 */
export type CompactionMode =
  | 'auto'
  | 'native'
  | 'micro'
  | 'reactive'
  | 'emergency_blocking'
  | 'recovery_413'
  | 'truncate_head'
  | 'hard_trim';

export interface CompactResult {
  compactedMessages: Message[];
  summary: string;
  tokensFreed: number;
  mode: CompactionMode;
  /** PRD-04 T2.7: compact LLM 调用消耗的 token（不含在主循环 usage 中） */
  compactUsage?: { input_tokens: number; output_tokens: number; model?: string };
  /**
   *  第二波：`compactedMessages` 尾部保留原文的消息条数
   * （= messagesToKeep 长度；tool 配对加宽时为加宽后的长度）。
   *
   * 消费者：`applyReuseSideEffects` 用 `compactedMessages.length - keptTailCount`
   * 推出"压缩后新数组坐标下已被摘要覆盖的前缀条数"（summary 消息 + 可选 ack），
   * 作为 `lastSummary.msgsCovered` 存入——修复跨压缩坐标系错位：旧实现把
   * **压缩前数组坐标**的 splitIdx 存进 msgsCovered，下一轮压缩在**压缩后新
   * 数组**上算 splitIdx，两个坐标系相减得到负数 → 永远命中 `no_new_messages`
   * 回落全量，单次长任务内第二次及以后的压缩事实上从未走过增量复用。
   *
   * 仅真实产出 summary 的路径填充；no-op / 兜底截断路径不填。
   */
  keptTailCount?: number;
  /**
   *  review 修复：`summary` 是兜底占位文案（layeredPrune / hardTrim /
   * softTrim 的固定说明文本），不是 LLM 产出的真实摘要。
   *
   * 消费者：`applyReuseSideEffects` 据此跳过 `lastSummary` 缓存写入——占位
   * 文案若被存为 PRIOR_SUMMARY，下一轮增量复用会把"上下文已被截断"当作
   * 前情提要拼进新摘要，污染后续所有压缩。
   */
  summaryIsPlaceholder?: boolean;
  /**
   * Wave 8：压缩后注入了多少个文件的内容 attachment。
   * 由 `compactConversation` 正常路径填充；emergency / hardTrim 不填。
   */
  attachmentsInjected?: number;
  /**
   * Wave 8：注入的文件 attachment 累计 token 估算值。
   */
  attachmentTokens?: number;
  /**
   * FR-16 H3-B：本次 compact 的复用情况（仅在 `compactConversation` 走"增量摘要
   * 复用前次 summary"路径时填充）。
   *
   * 字段全部 optional 以保持向后兼容——任何未启用 reuse 的旧调用（如 hard_trim
   * 路径或 reactive 路径）依然能继续返回 `CompactResult` 而不需感知本字段。
   *
   * 消费者：
   * - `runCompactionPhase` 据此 (1) 用 `summary` + 新增覆盖范围更新
   *   `CompactionOrchestratorState.lastSummary`；(2) 发 `compact.summary_reused` /
   *   `compact.fallback_full` 埋点；(3) 触发 LLM judge 采样并把分数写回
   *   `CompactionOrchestratorState.reuseStats`。
   * - 测试代码：断言 reuse 路径与全量路径行为差异。
   */
  reuseInfo?: SummaryReuseInfo;
}

/**
 * FR-16 H3-B：`compactConversation` 的复用结果详情。
 *
 * - `reused: true` 表示本次走了"基于前次 summary + 新增消息的增量摘要" prompt；
 *   `reused: false` 时其余字段都不会填，调用方应当走全量 summary 行为。
 * - `previousAgeMs` 是从 `previousSummary.generatedAt` 到现在的间隔——埋点用于
 *   排查"是否大量短间隔重复 reuse"。
 * - `tokensSaved` 反映"全量与本次 reuse 的 LLM 输入 token 差"——按 `tokensCovered`
 *   (前次覆盖) - `previousSummaryTokens` (本次仅送 summary 文本) 估算。
 *   只在 reuse 实际下发 LLM 调用时填，失败回落到全量则置 0。
 * - `msgsAdded` 是相比 `previousSummary.msgsCovered` 多覆盖了几条原始消息——
 *   `compactConversation` 在 reuse 路径里用它作为"增量 LLM input 的消息条数"。
 * - `coveredMsgsBefore` / `coveredMsgsAfter` 是 reuse 写入新 `lastSummary` 时
 *   的"前后覆盖范围"——两值相减即 `msgsAdded`，留两个独立字段是为了 dashboard
 *   过滤"reuse 覆盖范围一直没增长"的可疑会话。
 * - `fallbackReason` 记录 reuse 触发降级的原因（`previousSummary` 缺失 / 没新增
 *   消息 / `enableSummaryReuse=false` / window 已 fallback 等）。reused=false 时
 *   填，方便埋点直接读。
 */
export interface SummaryReuseInfo {
  reused: boolean;
  previousAgeMs?: number;
  tokensSaved?: number;
  msgsAdded?: number;
  coveredMsgsBefore?: number;
  coveredMsgsAfter?: number;
  fallbackReason?: SummaryReuseFallbackReason;
}

/**
 * FR-16 H3-B：`compactConversation` reuse 失败 / 不触发 reuse 的根因枚举。
 *
 * - `disabled`：`enableSummaryReuse === false`（开发者 / 运维显式关闭）。
 * - `no_previous_summary`：`previousSummary` 不存在——首次 compact 必走此路。
 * - `no_new_messages`：`messagesToSummarize.length <= previousSummary.msgsCovered`
 *   说明本次 splitIdx 没扩展，直接复用旧 summary 没意义。
 * - `judge_window_fallback`：reuse 历史 judge 窗口平均分 < 阈值，本次回退一次
 *   全量重建 summary 然后 reset 窗口。
 * - `summary_too_old`：`previousSummary.generatedAt` 与当前时差超过
 *   `EngineConfig.summaryReuseMaxAgeMs` 配置；当前默认无上限，留作可配置兜底。
 * - `incremental_call_failed`：reuse LLM 调用本身抛错或返回空，自动回落全量。
 *
 * 与 `CompactResult.reuseInfo.fallbackReason` 同集合；与
 * `compact.fallback_full` 埋点的 `reason` 字段共享同一个值集，避免运维侧需要
 * 维护两套字典。
 */
export type SummaryReuseFallbackReason =
  | 'disabled'
  | 'no_previous_summary'
  | 'no_new_messages'
  | 'judge_window_fallback'
  | 'summary_too_old'
  | 'incremental_call_failed'
  /**
   * H3-B Review 修复：`messagesToSummarize` 超过 `MAX_SUMMARY_INPUT_TOKENS`，
   * 必须走 chunkedCompact 分段路径——这种"原文超大不适合 reuse"与 reuse LLM
   * 调用本身失败语义不同，单独 reason 让 dashboard 不误归到质量问题。
   */
  | 'oversize_no_reuse';

/**
 * FR-16 H3-B：`CompactionOrchestratorState.lastSummary` 的结构（ 批次 8 自 EngineState 迁入）。
 *
 * - `content`：上次 compact 输出的 summary 文本（`CompactResult.summary` 直接缓存）。
 * - `generatedAt`：写入缓存的 `Date.now()`，供 `summary_too_old` 判定 + 埋点
 *   `previous_summary_age_ms` 计算。
 * - `msgsCovered`：上次 summary 覆盖了原始 `state.messages` 的前 N 条，对应
 *   `compactConversation` 内部 `splitIdx`。下次 reuse 时只需把 `messages[N..]`
 *   作为"增量 NEW_MESSAGES"喂给 LLM。
 * - `tokensCovered`：上次 summary 覆盖范围的 token 估算值（`estimateTokens`）。
 *   单独保存而不是每次重算是为了：(1) 节省一轮估算；(2) 后续 reuse 时
 *   "tokens_saved = tokensCovered - currentSummaryTokens" 能做精确对比。
 *
 * 与 `MessagesNormalizer` 等纯函数模块不同，本结构主要在
 * `runCompactionPhase` ↔ `compactConversation` 间流动；其它消费者只读不写。
 */
export interface SummaryReuseEntry {
  content: string;
  generatedAt: number;
  msgsCovered: number;
  tokensCovered: number;
}

/**
 * FR-16 H3-B：默认 LLM judge 采样率（5%）。每次 reuse 命中后以此概率发 1 次额外
 * LLM 调用做质量评分。设为 0 关闭 judge（reuse 仍生效，但失去自动质量监控）。
 */
export const DEFAULT_SUMMARY_REUSE_JUDGE_SAMPLE_RATE = 0.05;

/**
 * FR-16 H3-B：默认 LLM judge 滑动窗口大小（100）。窗口满后看平均分；< threshold
 * 触发一次 fallback_full + reset 窗口（PRD §5.2 第 7 行 "连续 100 次"）。
 */
export const DEFAULT_SUMMARY_REUSE_JUDGE_WINDOW_SIZE = 100;

/**
 * FR-16 H3-B：默认 LLM judge 平均分阈值（0.85）。低于该值视为质量退化，触发回退。
 *
 * **与 PRD §5.2 + §10 Q4 的关系**：
 * - PRD §5.2 验收标准 "summary 质量不明显下降（LLM judge 评分 ≥ 0.9）" 是产品
 *   稳态目标——希望 reuse 平均分长期稳定 ≥ 0.9。
 * - PRD §10 Q4 决策"连续 100 次样本评分 < 0.85 自动回退" 是**自愈红线**——0.85
 *   是触发回退的硬阈值，不是验收下限。
 * - 实现端这里的默认 `0.85` 对齐"自愈红线"。运维若希望更严的 dashboard 告警，
 *   可独立配置告警面板"p50 < 0.9 持续 N 天"，但触发 fallback 仍走 0.85。
 *
 * 落 [0.85, 0.9) 区间时既不达 PRD 稳态目标也不触发自愈——这是产品决策的"灰区"，
 * 应在 dashboard 层另设监控告警（见 TELEMETRY.md §11.4 健康基线）。
 */
export const DEFAULT_SUMMARY_REUSE_JUDGE_THRESHOLD = 0.85;

/**
 * FR-16 H3-B：LLM judge 函数签名。
 *
 * 输入：
 * - `previousSummary`：本次 reuse 引用的"前次 summary"文本（直接来自 `CompactionOrchestratorState.lastSummary`）。
 * - `newSummary`：reuse 路径产出的 updated summary 文本。
 * - `addedMessages`：自上次 summary 以来新增的原始消息（仅用于 judge 看到上下文，
 *   judge prompt 实现可据此询问"新消息是否被合理 fold 进 newSummary"）。
 * - `model` / `callModel`：judge 自己发 LLM 调用的入口；接受同 `LLMRequest` 协议
 *   以便完整复用 Provider 的鉴权 / 重试 / cache。
 *
 * 输出：
 * - `score ∈ [0, 1]` 数值越大质量越好；返回 `null` 表示 judge 失败（如 LLM 抛错 /
 *   响应非数字），调用方应跳过该样本，不要影响窗口统计。
 *
 * 实现端**永不抛**——失败统一返回 `null`。
 */
export type SummaryJudgeFn = (input: {
  previousSummary: string;
  newSummary: string;
  addedMessages: Message[];
  model: string;
  callModel: (request: LLMRequest) => AsyncIterable<LLMResponseChunk>;
}) => Promise<number | null>;

/**
 * FR-16 H3-B：`CompactionOrchestratorState.reuseStats` 的结构（ 批次 8 自 EngineState 迁入）。LLM judge 评分滑动窗口。
 *
 * - `scores`：最近 N 次 reuse 命中后的 LLM judge 评分（0-1）。当窗口长度达到
 *   `summaryReuseJudgeWindowSize`（默认 100）时计算平均分；< `summaryReuseJudgeThreshold`
 *   （默认 0.85）则下次 compact 走 fallback_full 一次，并 reset 此结构。
 * - `fallbackTriggered`：本次 fallback 是否已发出。query 主循环每次 compact 后
 *   读这个字段决定下一次是否真的走全量；用完即 reset。
 * - `consecutiveFailures`：保留供 judge LLM 调用本身失败时计数（不计入 scores）。
 *   连续 N 次失败可以选择关闭采样窗口避免噪声，本期仅记录不消费。
 *
 * 默认 `undefined` 表示从未跑过 reuse + judge——`runCompactionPhase` 第一次
 * 写 reuse 才懒初始化；旧 host / 测试 stub 不感知该字段。
 */
export interface SummaryReuseStats {
  scores: number[];
  fallbackTriggered: boolean;
  consecutiveFailures: number;
}

// ─── Session / Transcript ───────────────────────────────────────────
//
// Wave 2（Anthropic Messages API 协议对齐）：messages.jsonl 直接落 Wave 1
// envelope 6 件套，外加会话链表兼容字段（uuid / parentUuid / timestamp /
// sessionId / cwd / version）供外部 transcript 工具链表化展示。详见
// `packages/agent-runtime/src/session/storage.ts` 头部 §4 注释 +
// `docs/agent-runtime/wire-protocol.md` §4。
//
// 老的 TranscriptEntry / TranscriptEntryType 字面型枚举（'user' / 'assistant' /
// 'tool_use' / 'tool_result' / 'system' / 'compact' / 'error'）已删——它们的
// 语义被 envelope 三件套覆盖：
//   - 'user' / 'assistant' / 'tool_use' / 'tool_result' → message_start +
//     content_block_start/delta/stop + message_stop 序列（role / block.type 区分）
//   - 'compact' / 'error' / 'system' → 仍由元事件白名单（agent.stream.compaction /
//     agent.stream.system_notice）经 host 透传，不再写入 messages.jsonl

/**
 * messages.jsonl 单行实体。
 *
 * 每行 = 一个 envelope event（Wave 1 stream-content-block.ts 6 件套之一）+
 * 会话链表兼容字段（让外部 transcript 工具能链表化展示）。
 *
 * **字段来源**：
 * - `uuid` / `parentUuid`：本仓库 storage 层生成（`${threadId}:${seq}`）。
 * - `timestamp` / `threadId`：storage 层注入。
 * - `version`：storage 层维护的单调序号，宿主 `onWrite` 回调使用（与 envelope
 *   payload 的 `_seq` 不同——`_seq` 是跨 thread 的全局序号，`version` 是
 *   本会话本地序号）。
 * - `type` / `payload`：来自 yield 的 `StreamEvent`（W1 6 件套之一）。
 *
 * **不写入 jsonl 的事件**：除 6 件套外的 StreamEvents（lifecycle / done /
 * system_notice / step / llm_request / compaction / user / billing 等元事件）
 * 不写 messages.jsonl —— 这些事件由 `eventStorage`（debug-obs 通道）单独落盘。
 * messages.jsonl 只承担"对话内容时间轴"职责。
 */
export interface TranscriptEntry {
  /** 会话链表唯一 ID（"<threadId>:<seq>" 形式）。 */
  uuid: string;
  /** 上一条 entry 的 uuid；首条为 null。 */
  parentUuid: string | null;
  /** 写入时刻 ISO8601（与 payload 的 started_at 区分）。 */
  timestamp: string;
  /** 本会话业务 thread ID（= envelope.payload.thread_id）。 */
  threadId: string;
  /** 本会话本地单调序号（onWrite 用；与 payload._seq 不同）。 */
  version: number;
  /** envelope event 类型（agent.stream.message_start / .message_delta / .message_stop / .content_block_start / .content_block_delta / .content_block_stop）。 */
  type: string;
  /** envelope payload（W1 schema 完整体，含 _seq / protocol_version / message_id 等）。 */
  payload: Record<string, unknown>;
  /** 会话兼容元信息：仅首条（首个 message_start）写入。运行环境上下文。 */
  cwd?: string;
  /** 会话兼容字段：标识 runtime 版本（"tabtin-runtime-v2"）。 */
  runtimeVersion?: string;
}

export interface SessionConfig {
  sessionDir: string;
  /**
   * 业务对话 thread ID（用户视角的"一段对话"）。跨多次 `query()` 共用，
   * 是 `host.sessions Map` 的 key，也是 wire envelope `payload.thread_id`
   * 的值。§17.6 D4：从原 `sessionId` 改名 `threadId`，让命名跟物理含义匹配。
   *
   * **不要**跟 runtime UUID（`AgentRuntime.getRuntimeId()`）混。
   */
  threadId: string;
  onWrite?: (entry: TranscriptEntry) => void;
  onCompact?: (result: CompactResult) => void;
}

export interface AutoCompactParams {
  messages: Message[];
  systemPrompt: string;
  model: string;
  contextWindowTokens: number;
  /** Path to the JSONL transcript file — included in compact summaries */
  transcriptPath?: string;
  /**
   *  第二波·任务连续性：当前会话的 active plan 指针（来自
   * `state/active-plan-tracker`，orchestrator 按 sessionId 查出后注入）。
   * 压缩完成后与未完成待办一起重注入 summary 消息，防止长任务压缩后
   * 丢"干到哪一步了"。`undefined` = 无活跃计划。
   */
  activePlanRef?: { kind: 'file' | 'document'; target: string };
  /** Usage anchor from last LLM response for hybrid token estimation */
  usageAnchor?: { inputTokens: number; messageCount: number; timestamp: number };
  /** Session-level compact failure tracking (passed through to autoCompactIfNeeded) */
  tracking?: { consecutiveFailures: number; lastFailureTime: number };
  /**
   * FR-16 H3-B：上次 compact 输出的 summary 缓存。
   *
   * 由 `runCompactionPhase` 从 `CompactionOrchestratorState.lastSummary` 透传到 `autoCompactIfNeeded` →
   * `compactConversation`，让后者按"前次 summary + 新增消息"做增量摘要而非
   * 每次都从头 summarize。`undefined` 时退化为现有全量行为（首次 compact 时此字段
   * 永远 `undefined`）。
   *
   * 透传链路：query.ts → orchestrator → query-deps `autoCompact` → autoCompactIfNeeded →
   * compactConversation。
   */
  previousSummary?: SummaryReuseEntry;
  /**
   * FR-16 H3-B：reuse 路径是否启用。`undefined` 时由 `compactConversation` 按
   * `EngineConfig.enableSummaryReuse` 默认值（true）行为。query.ts 把
   * `EngineConfig.enableSummaryReuse` 透传过来；测试可在 mock 调用中显式覆盖。
   */
  enableSummaryReuse?: boolean;
  /**
   * FR-16 H3-B：判定 `previousSummary` 是否过新仍可复用的最大年龄（ms）。
   * `undefined` 时不限制——与 PRD §5.2 默认行为一致。
   */
  summaryReuseMaxAgeMs?: number;
  /**
   * FR-16 H3-B：触发 reuse 的最小新增消息条数。`undefined` 时按 compactConversation
   * 默认（3）。短消息高频对话场景里 reuse 反而比全量贵——此阈值是防御。
   */
  summaryReuseMinAddedMessages?: number;
  /**
   * FR-16 H3-B：本轮强制走全量 fallback 的原因（典型值 `'judge_window_fallback'`）。
   *
   * `runCompactionPhase` 在检测到上次 judge 窗口已 marked 时通过此字段告知
   * `compactConversation`，让后者在 reuseInfo 上正确写 `fallbackReason` 让宿主
   * 统一发 `compact.fallback_full` 埋点。`undefined` 时按其余条件正常判定。
   */
  forceFallbackReason?: SummaryReuseFallbackReason;
  /**
   * Wave 8：压缩后注入文件内容 attachment 的 token 预算。
   * 透传给 `compactConversation`。`undefined` 时用默认值 20k。
   * emergency / hardTrim 路径传 0 禁止注入。
   */
  postCompactAttachmentBudget?: number;
}
