/**
 * Memory Hook —— 每轮把 AgentMemory 相关记忆注入 messages。
 *
 * **归属（ Phase 1）**：本 hook 原名 `buildMemoryInjectorHook`，住在
 * `@tabtin/agent-runtime` 的 `capability/injectors/memory-injector.ts`。因它依赖
 * `@tabtin/agent-prompt`，随「引擎零业务依赖」重构迁到宿主 `@tabtin/agent-host/hooks`。
 * 行为逐字节一致，仅换归属与工厂名（`buildMemoryInjectorHook` → `buildMemoryHook`）。
 *
 * **行为（结构照抄 context hook）**：
 *   1. 读 `agentConfig.enabled` && `agentConfig.injection.auto_inject`——任一 false → 跳过
 *   2. 从 `state.messages` 倒序找最近一条真用户 message 的 text 当 query；空 → 跳过
 *   3. `await fetchMemories(query, limit)`；try/catch 失败 → 静默跳过（对齐 context hook）
 *   4. 空数组 → 跳过
 *   5. 渲染 `<context type="memory-recall">` 块 = buildMemoryRecallSection(memos)
 *   6. per-run 幂等闸门；插到 CONTEXT_INJECTION 块之后，否则贴当前 user 之前
 *   7. charBudget 默认 800，超限尾截
 *
 * **检索语义**：本 hook 仍把最近用户原文当 `query` 原样传给后端；
 * 「相关 top-K」由后端统一检索层（分词 + 关键词 OR 候选 + 命中数打分 +
 * 分数/新鲜度排序）完成——不是整句 `icontains`，也不是向量全文检索。
 * 低于候选阈值（零关键词命中）的行不会返回，hook 侧空数组即跳过注入。
 *
 * **段文本 SSoT**：渲染逻辑在 `@tabtin/agent-prompt` buildMemoryRecallSection。
 */

import {
  buildMemoryRecallSection,
  buildUserContextWrapper,
  type MemoryRecallEntry,
} from '@tabtin/agent-prompt'
import type { Message, EngineHooks, IterationHookContext } from '@tabtin/agent-runtime/engine'
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  findLastRealUserIndex,
} from '@tabtin/agent-runtime/engine'
import { upsertTaggedBlock } from './message-inject.js'

// ─── Public Types ────────────────────────────────────────────────────

/**
 * 召回入参契约——同 `@tabtin/agent-runtime` `MemorySummary`（一份字段在
 * agent-prompt 包重复声明是为了不形成 runtime → prompt 反向依赖）。
 */
export type MemoryRecallSummary = MemoryRecallEntry

/**
 * memory hook 工厂选项。收「闭包回调」——把 agentConfig / 调 API 的细节交给宿主，
 * hook 自己只做 fetch + 渲染 + 注入（可单测、不直接依赖 DataToolsDeps）。
 */
export interface MemoryHookOptions {
  /**
   * 拉 agent_config.memory 配置子段——每轮调，宿主可以挂 reactive 状态。
   * 返回 undefined / 缺 `enabled` / 缺 `injection.auto_inject` → 跳过注入。
   */
  fetchAgentConfig: () =>
    | { enabled?: boolean; injection?: { auto_inject?: boolean } }
    | undefined
  /**
   * 调 `/agent-memory` 按 query 拉相关 top-K 记忆——返回非空数组才注入。
   * 后端语义见 （关键词检索，非整句子串）；失败语义：throw / reject
   * 都被本 hook try/catch 吞掉走"静默跳过"路径。
   */
  fetchMemories: (query: string, limit: number) => Promise<MemoryRecallSummary[]>
  /** 字符上限——超出尾截 + 截断标记。默认 800（spec 拍板）。 */
  charBudget?: number
  /** `fetchMemories` 单轮拉条数上限。默认 5。 */
  recallLimit?: number
}

// ─── Internal Constants ──────────────────────────────────────────────

const DEFAULT_CHAR_BUDGET = 800
const DEFAULT_RECALL_LIMIT = 5
const MEMORY_MARKER = INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION
const CONTEXT_MARKER = INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * 构造 memory hook —— per-run 单块注入（ 幂等闸门），把 `fetchMemories`
 * 返回的 top-K memo 渲染成 `<context type="memory-recall">` user message 注入到
 * 当前 user 消息之前（紧挨 `<context type="environment">` 之后，见 ）。
 */
export function buildMemoryHook(options: MemoryHookOptions): EngineHooks {
  const charBudget = options.charBudget ?? DEFAULT_CHAR_BUDGET
  const recallLimit = options.recallLimit ?? DEFAULT_RECALL_LIMIT
  const { fetchAgentConfig, fetchMemories } = options

  return {
    async beforeIteration(ctx: IterationHookContext): Promise<void> {
      const state = ctx.state
      // per-run 幂等闸门：本 run 已注入过 → 跳过，不改 messages。
      if (state.messages.some((m) => hasInternalMarker(m, MEMORY_MARKER))) return

      // 1. 守门员：拉 agent_config，缺 enabled / auto_inject 任一开关 false → 跳过。
      const agentConfig = fetchAgentConfig()
      if (!agentConfig?.enabled) return
      if (!agentConfig.injection?.auto_inject) return

      // 2. 找最近一条真用户 user message 当 query（幂等闸门已保证无本轮 memory 块）。
      const query = pickLatestUserQuery(state.messages)
      if (!query) return

      // 3. fetchMemories 静默吞错——网络 / 5xx / timeout 不阻断 iteration。
      let memos: MemoryRecallSummary[]
      try {
        memos = await fetchMemories(query, recallLimit)
      } catch {
        return
      }
      if (!memos.length) return

      // 4. 渲染 + 预算裁剪——文本 SSoT 在 agent-prompt buildMemoryRecallSection。
      const rendered = buildMemoryRecallSection(memos)
      if (!rendered) return
      const body = clipToCharBudget(rendered, charBudget)

      // 5. 阶段 6 议题 2：用 user-context-wrapper SSoT 统一外壳。
      const content = buildUserContextWrapper('memory-recall', body)

      // 6. 插入位置：紧跟 context 之后（`[..., context, memory_recall, current_user]`）；
      //    没有 context 时退到「当前 user 之前」；连真用户消息都找不到 → append。
      state.messages = upsertTaggedBlock(state.messages, {
        marker: MEMORY_MARKER,
        content: [{ type: 'text', text: content }],
        position: (filtered) => {
          const ctxIdx = filtered.findIndex((m) => hasInternalMarker(m, CONTEXT_MARKER))
          if (ctxIdx >= 0) return ctxIdx + 1
          const userIdx = findLastRealUserIndex(filtered)
          return userIdx < 0 ? filtered.length : userIdx
        },
      })
    },
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * 从 messages 倒序找最近一条"真用户" user message，取出 text block 内容拼成 query。
 * 跳过本 hook / context / LSP / 各内部 marker 注入的 user 消息。
 * 返回 trimmed 串；空串 / 没有 user message → 返回 null。
 */
function pickLatestUserQuery(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    if (hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION)) continue
    if (hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)) continue
    if (hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION)) continue
    if (hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.LSP_DIAGNOSTICS_INJECTION)) continue
    if (hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.CONTINUATION)) continue
    if (hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION)) continue
    if (hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.TODO_STATE_INJECTION)) continue
    if (hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.TODO_COMPLETION_NUDGE)) continue
    // 项目规则自动加载：rules hook unshift 到 messages[0] 的 `<project_rules>` 是
    // "项目规约"而非用户输入——倒序扫到它不能当召回 query（显式 skip 作防御）。
    if (hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.PROJECT_RULES_INJECTION)) continue

    const text = extractText(m)
    if (!text) continue
    const trimmed = text.trim()
    if (!trimmed) continue
    return trimmed
  }
  return null
}

/**
 * 把 message 里所有 text block 拼成一个串——通常 user message 只有 1 个 text block，
 * 但工具结果 / 富内容回流可能多块；走 join 兜底。
 */
function extractText(message: Message): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/**
 * charBudget 裁剪——只在尾部硬截 + 加截断标记（不做 token 估算，主路径每轮调）。
 */
function clipToCharBudget(text: string, budget: number): string {
  if (text.length <= budget) return text
  return `${text.slice(0, budget)}\n[memory recall truncated due to budget]`
}
