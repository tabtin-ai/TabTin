import { useCallback, useEffect } from 'react'
import { BROWSER_ANNOTATION_INJECT_EVENT, type BrowserAnnotationInjectPayload } from '../context/browserAnnotationInjection'
import { usePendingComposerAttachmentsStore } from '@/stores/usePendingComposerAttachmentsStore'
import { revokeAttachmentPreview, type ChatAttachment, type ContextRef } from '../types'

interface BrowserAnnotationParams {
  acceptGlobalInputEvents: boolean
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>
  onAddContextRef?: (
    type: import('../types').ContextRefType,
    resourceId: string,
    label: string,
    extra?: Partial<ContextRef>,
  ) => void
}

export function useChatInputBrowserAnnotationListener({
  acceptGlobalInputEvents,
  setAttachments,
  onAddContextRef,
}: BrowserAnnotationParams) {
  useEffect(() => {
    if (!acceptGlobalInputEvents) return
    const handleBrowserAnnotationInject = (event: Event) => {
      const payload = (event as CustomEvent<BrowserAnnotationInjectPayload>).detail
      if (!payload?.contextRef) return
      // 投递确认：发射方据此判断是否需要走「自动开新任务草稿」兜底
      payload.consumed = true

      if (payload.attachment) {
        setAttachments(prev => {
          if (prev.some(att => att.id === payload.attachment!.id)) {
            revokeAttachmentPreview(payload.attachment!)
            return prev
          }
          return [...prev, payload.attachment!]
        })
      }

      const ref = payload.contextRef
      onAddContextRef?.(ref.type, ref.resourceId, ref.label, {
        spaceId: ref.spaceId,
        spaceName: ref.spaceName,
        tabType: ref.tabType,
        meta: ref.meta,
      })
    }

    window.addEventListener(BROWSER_ANNOTATION_INJECT_EVENT, handleBrowserAnnotationInject)
    return () => {
      window.removeEventListener(BROWSER_ANNOTATION_INJECT_EVENT, handleBrowserAnnotationInject)
    }
  }, [acceptGlobalInputEvents, onAddContextRef, setAttachments])
}

/**
 * 领取「composer 尚未挂载时排队」的附件（ 兜底链路）。
 *
 * scope 与 composer preset / context injection 同源（sessionId ?? __draft__:spaceId）。
 * 响应式领取：无论附件先入队还是 ChatInput 先挂载，队列一旦非空即领取合并，
 * 按 attachment.id 去重（同 id 丢弃来路副本并回收预览 URL）。
 */
export function useChatInputPendingAttachmentClaim(
  presetScopeId: string | null | undefined,
  sessionId: string | null | undefined,
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>,
) {
  // 与 draftFlags.resolvedPresetScopeId 同源
  const claimScopeId = presetScopeId ?? sessionId ?? null
  const pending = usePendingComposerAttachmentsStore(
    useCallback(
      (s) => (claimScopeId ? s.pendingByScopeId[claimScopeId] : undefined),
      [claimScopeId],
    ),
  )

  useEffect(() => {
    if (!claimScopeId || !pending || pending.length === 0) return
    const claimed = usePendingComposerAttachmentsStore.getState().claim(claimScopeId)
    if (claimed.length === 0) return
    setAttachments(prev => {
      const existingIds = new Set(prev.map(att => att.id))
      const fresh = claimed.filter(att => {
        if (existingIds.has(att.id)) {
          revokeAttachmentPreview(att)
          return false
        }
        return true
      })
      return fresh.length > 0 ? [...prev, ...fresh] : prev
    })
  }, [claimScopeId, pending, setAttachments])
}
