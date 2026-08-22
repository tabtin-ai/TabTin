import { useCallback, useMemo } from 'react'
import { contextRefsToBlocks } from '../context/useContextInjection'
import type { ContextRef } from '../types'

export function useChatInputContextRefPartitions(allContextRefs: ContextRef[]) {
  const conversationReferenceRefs = useMemo(
    () => allContextRefs.filter(ref => ref.type === 'conversation_reference'),
    [allContextRefs],
  )
  const chipContextRefs = useMemo(
    () => allContextRefs.filter(ref => ref.type !== 'conversation_reference'),
    [allContextRefs],
  )

  const buildContextBlocks = useCallback(() => {
    // ：conversation_reference 也进 userMessageBlocks（codec 落 session_id/raw_block），
    // 切会话 / prefill 才能恢复 chip；Agent 仍靠 prepareComposerSendContent 拼 XML 正文。
    if (allContextRefs.length === 0) return undefined
    return contextRefsToBlocks(allContextRefs)
  }, [allContextRefs])

  return {
    conversationReferenceRefs,
    chipContextRefs,
    buildContextBlocks,
  }
}
