/**
 * useSubagentRuns — W3 聚合视图共享 hook
 *
 * `useSubagentRun`（单数）按单个 id 反查 SubagentRun，本 hook 按一组 id
 * 反查一组 SubagentRun——给 `SubagentAggregateView` 这类同时展示多个子任务
 * 状态的组件用。
 *
 * ## 双向匹配（与 useSubagentRun 一致）
 *
* 数组中每个 id 走两条匹配规则任选其一命中：
*   1. `r.subagentRunId === id`（精确）—— 子 Agent 会话身份；resume 后可能复用
*   2. `r.parentToolCallId === id`（反查）—— 父 LLM 给的 `tool_use.id`（toolu_xxx）
 *
 * 调用方（W3 BlockTimeline 聚合检测）传入的通常是**父 `tool_use.id`** 数组
 * （连续多个 subagent tool_use block 的 block.id），通过反查得到真实的
 * SubagentRun 对象——再交给 SubagentAggregateView 渲染。
 *
 * ## 性能
 *
 * 用 `useShallow` 对返回的 SubagentRun[] 做浅相等比较：
 *   - 数组长度不变 + 每个元素引用不变（store 没产生新对象） → 跳过 re-render
 *   - 任一元素引用变 / 长度变 → 触发 re-render
 *
 * 这是 zustand 官方推荐的"selector 返回数组时配 useShallow"模式——避免高频
 * SUBAGENT_PROGRESS 事件下 AggregateView 整组 re-render。
 *
 * ## ids 顺序保持
 *
 * 返回数组的元素顺序按入参 `ids` 顺序排列（不是 store 内自然顺序）——让
 * BlockTimeline 把"渲染时序"传给 AggregateView，避免聚合后子任务顺序与
 * tool_use block 在主对话中的物理顺序不一致造成的认知割裂。
 *
 * `ids` 中查不到的元素会被过滤掉（不返回 undefined 占位）——本 hook 只负责
 * 「把真实 SubagentRun 反查出来」。反查窗口期（SUBAGENT_STARTED 未到达）缺位
 * 的补齐**不在本 hook**：由 `BlockTimeline.SubagentAggregateGroup.displayRuns`
 * 在实时窗口用 tool_use(agent) 块合成乐观占位行（isOptimistic）顶上，非实时
 * 窗口则交给 SubagentAggregateView 的 skeleton 兜底。详见 BlockTimeline 注释。
 */

import { useShallow } from 'zustand/react/shallow'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import type { SubagentRun } from '../../../stores/chat/shared/types'
import { matchSubagentRunsByIds } from '../utils/matchSubagentRuns'

export function useSubagentRuns(
  sessionId: string | null,
  ids: readonly string[],
  ownerRunId?: string,
): SubagentRun[] {
  return useChatRuntimeStore(
    useShallow((s): SubagentRun[] => {
      if (!sessionId || ids.length === 0) return EMPTY_RUNS
      const runs = s.subagentRunsBySessionId[sessionId]
      if (!runs || runs.length === 0) return EMPTY_RUNS
      const result = matchSubagentRunsByIds(runs, ids, ownerRunId)
      return result.length === 0 ? EMPTY_RUNS : result
    }),
  )
}

/**
 * 共享空数组引用——避免 selector 在"查无 run"路径上每次返回 `[]` 新引用
 * 触发 useShallow 不必要的 re-render。
 */
const EMPTY_RUNS: SubagentRun[] = []
