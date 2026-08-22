/** @store-category ui */

import { create } from 'zustand'

interface CreateSiteOptions {
  name: string
  template: string
  framework: string
}

interface CreateSiteDialogState {
  isOpen: boolean
  resolve: ((opts: CreateSiteOptions | null) => void) | null

  /** 打开 Dialog，返回用户填写结果；用户取消时返回 null */
  open: () => Promise<CreateSiteOptions | null>

  /** Dialog 内部调用：提交或取消 */
  close: (result: CreateSiteOptions | null) => void
}

export const useCreateSiteDialog = create<CreateSiteDialogState>((set, get) => ({
  isOpen: false,
  resolve: null,

  open: () =>
    new Promise<CreateSiteOptions | null>((resolve) => {
      set({ isOpen: true, resolve })
    }),

  close: (result) => {
    const { resolve } = get()
    resolve?.(result)
    set({ isOpen: false, resolve: null })
  },
}))
