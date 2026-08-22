import { useChatStore } from '@/stores/chat/useChatStore'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { useSessionBusy } from '@/stores/chat/execution/sessionRunProjection'

/**
 * 会话级 Agent 回合脉冲是否可见（等待壳 / suppressInlineLoading 共用）。
 *
 * 显示：session 正在跑（ 执行态单一投影），且非 HITL 挂起（审批 / askUser /
 * WS suspended）。隐藏：lifecycle 终态、用户 cancel、HITL 等待用户操作。
 *
 * ：busy 改订阅投影（useSessionBusy）而非经 useChatStore selector 间接读——
 * 后者的重渲染时机依赖 chat store 变更，投影单独变化（乐观派发窗口）时会滞后。
 * W4.4 刻意在审批期间保持 busy，此处单独判定 HITL 态。
 * 亦导出为 useAgentTurnPulseVisible（见同目录别名文件）。
 */
export function useAgentStreamingTailVisible(sessionId: string | null): boolean {
  const isStreaming = useSessionBusy(sessionId)
  const pendingApproval = useChatStore((s) =>
    sessionId ? !!s.pendingApprovalBySessionId[sessionId] : false,
  )
  const pendingAskUser = useChatStore((s) =>
    sessionId ? !!s.pendingAskUserBySessionId[sessionId] : false,
  )
  const runStateSuspended = useChatRuntimeStore((s) =>
    sessionId ? !!s.runStateBySessionId[sessionId]?.suspended : false,
  )

  return isStreaming && !pendingApproval && !pendingAskUser && !runStateSuspended
}
