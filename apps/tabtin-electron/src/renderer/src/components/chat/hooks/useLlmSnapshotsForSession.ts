import { useCallback, useEffect } from 'react'
import type { ChatMessage } from '@tabtin/chat-client'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import type { LLMCallSnapshot } from '@/stores/chat/shared/types'

const EMPTY_CLOUD_MESSAGES: ChatMessage[] = []
const EMPTY_LOCAL_SNAPSHOTS: LLMCallSnapshot[] = []

export function useLlmSnapshotsForSession(sessionId: string | null | undefined) {
  const snapshots = useChatRuntimeStore(
    useCallback(
      (s) => (sessionId ? s.snapshotsBySessionId[sessionId] : undefined),
      [sessionId],
    ),
  )
  const cloudMessages = useChatStore(
    useCallback(
      (s) => (sessionId ? s.messagesBySessionId[sessionId] ?? EMPTY_CLOUD_MESSAGES : EMPTY_CLOUD_MESSAGES),
      [sessionId],
    ),
  )
  useEffect(() => {
    if (!sessionId || snapshots?.length) return
    // 反查 session 所属 (organizationId, spaceId) 一起传过去。main 进程的 fallback
    // (`this.sessions.get(sessionId)`) 仅覆盖当前活跃 live session——一旦切走
    // 或刷新过页面，历史 session 不在 live map，会兜底到 `_unscoped/_unscoped`
    // 桶并返回空数组，导致本地快照 tab 恒为空。
    const chatState = useChatStore.getState()
    let organizationId: string | undefined
    let spaceId: string | undefined
    for (const list of Object.values(chatState.sessionsBySpaceId)) {
      const s = list.find((x) => x.id === sessionId)
      if (s) {
        organizationId = s.organization_id
        spaceId = s.space_id ?? undefined
        break
      }
    }
    useChatRuntimeStore.getState().loadSnapshotsForSession(
      sessionId,
      organizationId && spaceId ? { organizationId, spaceId } : undefined,
    )
  }, [sessionId, snapshots?.length])

  const localSnapshots = snapshots ?? EMPTY_LOCAL_SNAPSHOTS

  return {
    snapshots: localSnapshots,
    cloudMessages,
    localSnapshotCount: localSnapshots.length,
    cloudMessageCount: cloudMessages.length,
  }
}
