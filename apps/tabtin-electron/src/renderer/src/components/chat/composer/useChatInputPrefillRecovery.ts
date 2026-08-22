import { useCallback, useEffect, useRef } from 'react'
import { useChatStore } from '@/stores/chat/useChatStore'
import {
  useChatRuntimeStore,
  type PrefillData,
  type SubmittedMessageSnapshot,
} from '@/stores/useChatRuntimeStore'
import { blockToContextRef } from '../context/blockToContextRef'
import { clearDrafts, saveDraft } from './chatInputDraft'
import type { ChatAttachment, AttachmentStatus, ContextRef } from '../types'

interface PrefillRecoveryParams {
  sessionId: string | null | undefined
  input: string
  onAddContextRef?: (
    type: import('../types').ContextRefType,
    resourceId: string,
    label: string,
    extra?: Partial<ContextRef>,
  ) => void
  setInput: (value: string | ((prev: string) => string)) => void
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  clearInputState: () => void
  hasCurrentComposerDraft: boolean
}

const EMPTY_DRAFT_KEYS_PENDING_CLEAR: string[] = []

export function useChatInputPrefillRecovery({
  sessionId,
  input,
  onAddContextRef,
  setInput,
  setAttachments,
  textareaRef,
  clearInputState,
  hasCurrentComposerDraft,
}: PrefillRecoveryParams) {
  const applyPrefillData = useCallback((prefillData: PrefillData) => {
    setInput(prefillData.message)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 260) + 'px'
    }

    if (prefillData.attachments && prefillData.attachments.length > 0) {
      setAttachments(prev => {
        const existingIds = new Set(prev.map(a => a.id))
        const restored: ChatAttachment[] = prefillData.attachments!
          .filter(sa => !existingIds.has(sa.id))
          .map(sa => ({
            id: sa.id,
            file: new File([], sa.filename),
            filename: sa.filename,
            mimeType: sa.mimeType,
            size: sa.size,
            type: sa.type,
            status: (sa.remoteUrl ? 'ready' : 'pending') as AttachmentStatus,
            fileId: sa.fileId,
            remoteUrl: sa.remoteUrl,
            previewUrl: sa.previewUrl,
          }))
        return restored.length > 0 ? [...prev, ...restored] : prev
      })
    }

    if (prefillData.contextBlocks && prefillData.contextBlocks.length > 0) {
      const restoredRefs = prefillData.contextBlocks
        .map(blockToContextRef)
        .filter((r): r is ContextRef => r !== null)
      if (restoredRefs.length > 0) {
        for (const ref of restoredRefs) {
          onAddContextRef?.(ref.type, ref.resourceId, ref.label, {
            spaceId: ref.spaceId,
            spaceName: ref.spaceName,
            meta: ref.meta,
          })
        }
      }
    }
  }, [onAddContextRef, setAttachments, setInput, textareaRef])

  const pendingPrefill = useChatRuntimeStore(
    useCallback(
      (s) => (sessionId ? s.pendingPrefillBySessionId[sessionId] : undefined),
      [sessionId],
    ),
  )

  useEffect(() => {
    if (!pendingPrefill || !sessionId) return
    const { consumePrefillForSession } = useChatRuntimeStore.getState()
    const prefillData = consumePrefillForSession(sessionId)
    if (!prefillData) return

    if (input.trim()) {
      // Composer 已有内容时只静默落本地草稿，不再弹 toast（停止/失败回填时易误扰）。
      saveDraft(sessionId, prefillData.message)
    } else {
      applyPrefillData(prefillData)
    }
  }, [applyPrefillData, input, pendingPrefill, sessionId])

  // ：ACK 成功后清空发送区（失败不递增 nonce，正文保留）。
  // 只响应「本组件存活期间」的递增，避免切回会话时用历史 nonce 误清草稿。
  const composerClearNonce = useChatStore(
    useCallback(
      (s) => (sessionId ? s.composerClearNonceBySessionId?.[sessionId] ?? 0 : 0),
      [sessionId],
    ),
  )
  const draftKeysPendingClear = useChatStore(
    useCallback(
      (s) => (
        sessionId
          ? s.composerDraftKeysPendingClearBySessionId?.[sessionId]
            ?? EMPTY_DRAFT_KEYS_PENDING_CLEAR
          : EMPTY_DRAFT_KEYS_PENDING_CLEAR
      ),
      [sessionId],
    ),
  )
  const composerClearNonceSeenRef = useRef(composerClearNonce)
  useEffect(() => {
    composerClearNonceSeenRef.current = composerClearNonce
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps -- 切会话时重置基线
  useEffect(() => {
    if (!sessionId || composerClearNonce <= composerClearNonceSeenRef.current) return
    composerClearNonceSeenRef.current = composerClearNonce
    clearInputState()
    clearDrafts(draftKeysPendingClear)
    useChatStore.getState().clearComposerDraftKeysPendingClear(sessionId)
  }, [clearInputState, composerClearNonce, draftKeysPendingClear, sessionId])

  const pendingInterruptedMessage = useChatRuntimeStore(
    useCallback(
      (s) => (sessionId ? s.pendingInterruptedMessageBySessionId[sessionId] : undefined),
      [sessionId],
    ),
  )

  const handleRestoreInterruptedMessage = useCallback(() => {
    if (!sessionId) return
    const recovery = useChatRuntimeStore
      .getState()
      .consumeInterruptedMessageRecovery(sessionId)
    if (!recovery) return
    clearInputState()
    applyPrefillData(recovery)
    if (recovery.replyTo) {
      useChatStore.getState().setReplyTarget(sessionId, recovery.replyTo)
    }
  }, [applyPrefillData, clearInputState, sessionId])

  const handleDiscardInterruptedMessage = useCallback(() => {
    if (!sessionId) return
    useChatRuntimeStore.getState().discardInterruptedMessageRecovery(sessionId)
  }, [sessionId])

  const applyInterruptedMessageRecovery = useCallback((
    recovery: SubmittedMessageSnapshot,
  ) => {
    applyPrefillData(recovery)
    if (recovery.replyTo && sessionId) {
      useChatStore.getState().setReplyTarget(sessionId, recovery.replyTo)
    }
  }, [applyPrefillData, sessionId])

  useEffect(() => {
    if (!pendingInterruptedMessage || !sessionId || hasCurrentComposerDraft) return
    const recovery = useChatRuntimeStore
      .getState()
      .consumeInterruptedMessageRecovery(sessionId)
    if (recovery) applyInterruptedMessageRecovery(recovery)
  }, [
    applyInterruptedMessageRecovery,
    hasCurrentComposerDraft,
    pendingInterruptedMessage,
    sessionId,
  ])

  return {
    applyPrefillData,
    pendingInterruptedMessage: !!pendingInterruptedMessage,
    handleRestoreInterruptedMessage,
    handleDiscardInterruptedMessage,
  }
}
