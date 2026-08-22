/**
 * useSubagentCancelState — W4c · R3-P1-7 共享 hook
 *
 * 给 `SubagentProgressCardRenderer`（cards/registry）和 `SubagentBlockEntry`
 * （blocks/ToolUseBlockView）共享同一份双源 selector 逻辑——避免双处独立
 * 维护"isCancelling = subagentRun 维度 OR 主 session 维度"的判断造成漂移。
 *
 * 单独抽到独立文件而非定义在某个 BlockRenderer 内部，是为了避免 components/
 * chat 内 `SubagentProgressCard` ↔ `blocks/ToolUseBlockView` 的循环依赖
 * （后者 import 前者用作子 Agent 入口卡片）。
 *
 * 使用示例：
 * ```ts
 * const { cancelSubagentRun, isCancelling } = useSubagentCancelState(
 *   subagentRunId,
 *   sessionId,
 * )
 * ```
 *
 * Selector 双源：
 *   - `subagentCancellingByRunId[subagentRunId] === true`：用户在 SubagentProgressCard
 *     上点 X 按钮触发 cancelSubagentRun → in-flight 期间为 true；服务端 ACK
 *     / 失败后清回 false
 *   - `cancellingBySessionId[sessionId] === true`：用户在主对话气泡点 stop，
 *     整个 turn 取消，所有子 Agent 也进入"取消中"状态
 *
 * 两源任一为真都返回 isCancelling=true，让 UI 统一显示"取消中…"替代 X 按钮。
 */

import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'

export function useSubagentCancelState(
  subagentRunId: string,
  sessionId: string | null,
): { cancelSubagentRun: (id: string) => Promise<void>; isCancelling: boolean } {
  const cancelSubagentRun = useChatRuntimeStore(s => s.cancelSubagentRun)
  const isCancelling = useChatRuntimeStore(s => {
    if (subagentRunId && s.subagentCancellingByRunId[subagentRunId]) return true
    if (sessionId && s.cancellingBySessionId[sessionId]) return true
    return false
  })
  return { cancelSubagentRun, isCancelling }
}
