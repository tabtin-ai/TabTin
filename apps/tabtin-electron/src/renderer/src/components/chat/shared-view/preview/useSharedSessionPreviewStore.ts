/** @store-category ui */

/**
 * 共享会话本地文件预览 — 全局 Drawer 状态。
 *
 * 与 CloudDocumentPreview / AgentSettingsSheet 同款：App 级 Host 读 store，
 * SharedSessionPane Context 只负责 open，避免 Dialog 挂在 pane 子树里。
 */

import { create } from 'zustand'

export interface SharedSessionPreviewTarget {
  sessionId: string
  shareId: string
  relativePath: string
  title?: string
}

interface SharedSessionPreviewState {
  target: SharedSessionPreviewTarget | null
  open: (target: SharedSessionPreviewTarget) => void
  close: () => void
}

export const useSharedSessionPreviewStore = create<SharedSessionPreviewState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}))
