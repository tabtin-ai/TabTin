/**
 * Relevant Recall Hook —— 每轮 iteration 注入相关能力召回块。
 *
 * **归属（ Phase 1）**：本 hook 原名 `buildRelevantRecallInjectorHook`，
 * 住在 `@tabtin/agent-runtime` 的 `capability/injectors/relevant-recall-injector.ts`。
 * 它本无 @tabtin 产品内容依赖，但随其余 5 段上下文贡献一起归到宿主
 * `@tabtin/agent-host/hooks`（同层聚合），行为逐字节一致，仅换工厂名
 * （`buildRelevantRecallInjectorHook` → `buildRelevantRecallHook`）。
 *
 * 承载 `<relevant_skills>` / `<relevant_mcp>` / `<relevant_cli>`——由 SkillsCap /
 * McpCap / CliCap 的 `getRelevantBlock()` 提供（宿主装配时接入 getRelevantContextBlocks）。
 *
 * **为什么从 context hook 拆出**：召回块要随 in_progress todo 推进每轮刷新，而环境
 * 快照 `<context>` 恰恰要按 run 冻结以保 prompt cache——二者诉求相反，故解耦。
 *
 * 位置：贴当前 user turn 尾部，排在 context / memory / active-todos 之后。
 */

import type {
  Message,
  EngineHooks,
  EngineState,
  IterationHookContext,
} from '@tabtin/agent-runtime/engine'
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  findLastRealUserIndex,
} from '@tabtin/agent-runtime/engine'
import { removeTaggedBlock, upsertTaggedBlock } from './message-inject.js'

export interface RelevantRecallHookOptions {
  /**
   * 返回当轮各能力的相关召回块（`<relevant_*>`）。宿主装配时接 SkillsCap /
   * McpCap / CliCap 的 `getRelevantBlock()`。顺序即注入顺序（skills → mcp → cli）。
   * 允许含 undefined / 空串——本 hook 过滤后拼接。
   */
  getRelevantContextBlocks: (state: EngineState) => Array<string | undefined>
}

const RELEVANT_RECALL_MARKER = INTERNAL_MESSAGE_MARKERS.RELEVANT_RECALL_INJECTION
const CONTEXT_MARKER = INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION
const MEMORY_MARKER = INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION
const TODO_STATE_MARKER = INTERNAL_MESSAGE_MARKERS.TODO_STATE_INJECTION

/**
 * 插入位置：紧跟 context / memory / active-todos 注入块之后（都贴在当前 user 之前）。
 * 无 context 块时回退到「最后一条真实 user 之前」。
 */
function findInsertIndex(filtered: readonly Message[]): number {
  const ctxIdx = filtered.findIndex((m) => hasInternalMarker(m, CONTEXT_MARKER))
  if (ctxIdx >= 0) {
    let insertAt = ctxIdx + 1
    while (
      insertAt < filtered.length &&
      (hasInternalMarker(filtered[insertAt]!, MEMORY_MARKER) ||
        hasInternalMarker(filtered[insertAt]!, TODO_STATE_MARKER))
    ) {
      insertAt += 1
    }
    return insertAt
  }
  const userIdx = findLastRealUserIndex(filtered)
  if (userIdx < 0) return filtered.length
  return userIdx
}

/**
 * 构造 relevant-recall hook —— per-iteration 单块注入。承载
 * `<relevant_skills>` / `<relevant_mcp>` / `<relevant_cli>`，随 in_progress todo
 * 推进每轮 filter + 重插。
 *  - 召回内容为空 → 不注入，写回 filtered（清掉可能残留的旧召回块）；
 *  - content = text-block、body 为**裸拼接串**（无 wrapper）；
 *  - 插位 = context/memory/todo 之后，否则真实 user 之前。
 */
export function buildRelevantRecallHook(options: RelevantRecallHookOptions): EngineHooks {
  const { getRelevantContextBlocks } = options

  return {
    async beforeIteration(ctx: IterationHookContext): Promise<void> {
      const state = ctx.state
      const filtered = removeTaggedBlock(state.messages, RELEVANT_RECALL_MARKER)

      const body = getRelevantContextBlocks(state)
        .filter((block): block is string => typeof block === 'string' && block.length > 0)
        .join('\n')

      // 无召回内容：写回 filtered（清掉可能残留的旧召回块）。
      if (body.length === 0) {
        state.messages = filtered
        return
      }

      state.messages = upsertTaggedBlock(state.messages, {
        marker: RELEVANT_RECALL_MARKER,
        content: [{ type: 'text', text: body }],
        position: (f) => findInsertIndex(f),
      })
    },
  }
}
