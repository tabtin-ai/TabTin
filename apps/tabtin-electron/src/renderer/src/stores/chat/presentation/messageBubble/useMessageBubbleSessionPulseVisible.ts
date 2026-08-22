import { useChatStore } from '@stores/chat/useChatStore'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useSessionBusy } from '@stores/chat/execution/sessionRunProjection'

export function useMessageBubbleSessionPulseVisible(sessionId: string | null): boolean {
  const isStreaming = useSessionBusy(sessionId)
  const pendingApproval = useChatStore((s) =>
    sessionId ? !!s.pendingApprovalBySessionId?.[sessionId] : false,
  )
  const pendingAskUser = useChatStore((s) =>
    sessionId ? !!s.pendingAskUserBySessionId?.[sessionId] : false,
  )
  const runStateSuspended = useChatRuntimeStore((s) =>
    sessionId ? !!s.runStateBySessionId[sessionId]?.suspended : false,
  )

  return isStreaming && !pendingApproval && !pendingAskUser && !runStateSuspended
}
