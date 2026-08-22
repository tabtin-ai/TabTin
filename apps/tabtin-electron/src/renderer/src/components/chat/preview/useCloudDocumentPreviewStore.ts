/** @store-category ui */

import { create } from 'zustand'

export interface CloudDocumentPreviewTarget {
  documentId: string
  resourceSpaceId: string
  organizationId?: string
  title?: string
  /** 打开预览后默认展开版本历史（任务产物「版本历史」次级入口） */
  openVersionHistory?: boolean
}

interface CloudDocumentPreviewState {
  target: CloudDocumentPreviewTarget | null
  open: (target: CloudDocumentPreviewTarget) => void
  close: () => void
}

export const useCloudDocumentPreviewStore = create<CloudDocumentPreviewState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}))
