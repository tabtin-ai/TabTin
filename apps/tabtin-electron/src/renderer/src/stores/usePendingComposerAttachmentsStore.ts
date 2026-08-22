/** @store-category session */

import { create } from 'zustand'
import { revokeAttachmentPreview, type ChatAttachment } from '@/components/chat/types'

/**
 * usePendingComposerAttachmentsStore — composer 附件的「待领取」队列
 *
 * 背景：截图/注释附件走 ChatInput 本地 state（setAttachments），
 * 目标 composer 尚未挂载时（如「工作台浏览器 → 自动开新任务草稿」兜底）无处可放。
 * 与 useContextInjectionStore 的 refs 对称：按 scope（sessionId / __draft__:spaceId）
 * 排队，ChatInput 挂载后 claim 领取合并进本地 attachments。
 *
 * 扩展：Composer 因切设置等卸载时，把当前未发送附件 enqueue 回本 store，
 * 重挂后同样走 claim，避免粘贴图片等待发送附件丢失（文本草稿见 ）。
 *
 * 内存语义：
 * - 不持久化。附件里有 File / objectURL，刷新即失效。
 * - claim 取走即清空；被丢弃（clearScope / rehome 目标已有同 id）时 revoke previewUrl，
 *   避免 objectURL 泄漏。
 */
interface PendingComposerAttachmentsState {
  pendingByScopeId: Record<string, ChatAttachment[]>
  /** 入队（按 attachment.id 去重，后到覆盖并 revoke 旧预览） */
  enqueue: (scopeId: string, attachment: ChatAttachment) => void
  /** 取走并清空该 scope 的全部待领取附件 */
  claim: (scopeId: string) => ChatAttachment[]
  /** 清空并 revoke 该 scope 的待领取附件 */
  clearScope: (scopeId: string) => void
}

export const usePendingComposerAttachmentsStore = create<PendingComposerAttachmentsState>((set, get) => ({
  pendingByScopeId: {},

  enqueue: (scopeId, attachment) => {
    set((state) => {
      const existing = state.pendingByScopeId[scopeId] ?? []
      const stale = existing.find(att => att.id === attachment.id)
      if (stale && stale !== attachment) revokeAttachmentPreview(stale)
      const next = stale
        ? existing.map(att => (att.id === attachment.id ? attachment : att))
        : [...existing, attachment]
      return {
        pendingByScopeId: { ...state.pendingByScopeId, [scopeId]: next },
      }
    })
  },

  claim: (scopeId) => {
    const claimed = get().pendingByScopeId[scopeId] ?? []
    if (claimed.length === 0) return []
    set((state) => {
      const { [scopeId]: _removed, ...rest } = state.pendingByScopeId
      return { pendingByScopeId: rest }
    })
    return claimed
  },

  clearScope: (scopeId) => {
    const pending = get().pendingByScopeId[scopeId] ?? []
    pending.forEach(revokeAttachmentPreview)
    if (pending.length === 0) return
    set((state) => {
      const { [scopeId]: _removed, ...rest } = state.pendingByScopeId
      return { pendingByScopeId: rest }
    })
  },
}))
