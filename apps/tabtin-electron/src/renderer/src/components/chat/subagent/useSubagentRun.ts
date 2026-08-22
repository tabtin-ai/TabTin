/**
 * useSubagentRun — W1 / D11 共享 hook
 *
 * 把 `subagentRunsBySessionId[sessionId].find(...)` 这条 selector 抽出来，
 * 作为 `SubagentBlockEntry`（和未来 W3 AggregateView 等组件）订阅
 * "完整 SubagentRun 对象"的统一入口。
 *
 * ## 双向匹配（W1 三视角 review · P0 修复 1）
 *
 * 第二个参数语义是「**run 标识符**」，匹配规则两条任选其一命中：
 *
 *   1. `r.subagentRunId === id`（**精确匹配**）—— 子 Agent 会话身份。resume
 *      会复用同一个 child id，因此具体父 tool_use 卡片应优先传 parentToolCallId。
 *   2. `r.parentToolCallId === id`（**反查匹配**）—— 父 LLM 给的 `tool_use.id`
 *      （`toolu_xxx`，由 W0-1 接通后透传到 SUBAGENT_STARTED.parent_tool_call_id）。
 *
 * ### 为什么必须支持反查
 *
 * `ToolUseBlockView::SubagentBlockEntry` 拿到的是 `block.id`（=父 LLM
 * 给的 `tool_use.id`，`toolu_xxx`），不是子 Agent 自己生成的 run UUID。
 * 之前 hook 只按 `subagentRunId` 精确匹配 → 父 UI 永远查不到 store 里的
 * 真实 SubagentRun → SubagentProgressCard 的所有字段（stepCount /
 * toolHistory / summary / stats / speakerId）都是 undefined，违背产品哲学
 * C2「每一步都看得见」、显示成"完成了但展开却空"的体验割裂。
 *
 * W0-1 已经把 `parent_tool_call_id` 透传到 `SubagentRun.parentToolCallId`
 * 字段（subagentHandler.ts:433），本 hook 在此基础上启用双向匹配——调用方
 * 不需要关心 id 到底是 child id 还是 parent tool_use.id；但同一 child 被 resume
 * 复用时，parent tool_use.id 才能唯一定位某次派活运行。
 *
 * ### 性能 / useShallow 的作用
 *
 * 直接 `find(...)` 在每次 Zustand store 整体重渲染时都会触发"新对象引用"
 * → 高频 SUBAGENT_PROGRESS 事件下 React 组件每帧 re-render。useShallow
 * 对返回的 SubagentRun 对象做**浅相等比较**：
 *   - 同字段值 → 跳过 re-render（即使新对象引用）
 *   - 任一字段变 → 触发 re-render
 *
 * 与 zustand 官方推荐的 "selector 返回对象时用 useShallow" 模式一致。
 *
 * ### 与 useSubagentCancelState 的关系
 *
 * useSubagentCancelState 只读 isCancelling / cancelSubagentRun 两个 primitive
 * 字段，本 hook 专门读"运行态完整对象"，两者职责互补不重叠。
 */

import { useShallow } from 'zustand/react/shallow'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { matchSubagentRunById } from '../utils/matchSubagentRuns'

export function useSubagentRun(
  sessionId: string | null,
  runIdOrToolCallId: string | undefined,
  ownerRunId?: string,
) {
  return useChatRuntimeStore(
    useShallow((s) => {
      if (!sessionId || !runIdOrToolCallId) return undefined
      const runs = s.subagentRunsBySessionId[sessionId]
      if (!runs) return undefined
      return matchSubagentRunById(runs, runIdOrToolCallId, ownerRunId)
    }),
  )
}
