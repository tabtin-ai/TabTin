/**
 * 流式首块撑高脉冲：独立订 blocks，避免 MessageList 为 token 级块更新
 * 去绑 materialize（ 渲染层）。
 */

import { useEffect, useRef } from 'react'
import { useSessionBlocksRecord } from '@stores/chat/messages/messageBlocks'

export function useStreamingTailFirstBlockPulse({
  sessionId,
  lastAssistantMsgId,
  isStreaming,
  onFirstBlock,
}: {
  sessionId: string | null
  lastAssistantMsgId: string | null
  isStreaming: boolean
  onFirstBlock: () => void
}) {
  const blocksRecord = useSessionBlocksRecord(sessionId)
  const markerRef = useRef<{ messageId: string; record: typeof blocksRecord; fired: boolean } | null>(
    null,
  )

  useEffect(() => {
    if (!isStreaming || !lastAssistantMsgId) {
      markerRef.current = null
      return
    }
    if (markerRef.current?.messageId !== lastAssistantMsgId) {
      markerRef.current = {
        messageId: lastAssistantMsgId,
        record: blocksRecord,
        fired: false,
      }
    }
  }, [isStreaming, lastAssistantMsgId, blocksRecord])

  useEffect(() => {
    const marker = markerRef.current
    if (
      !marker
      || marker.messageId !== lastAssistantMsgId
      || marker.fired
      || marker.record === blocksRecord
    ) {
      return
    }
    onFirstBlock()
    if (markerRef.current === marker) marker.fired = true
  }, [blocksRecord, lastAssistantMsgId, onFirstBlock])
}
