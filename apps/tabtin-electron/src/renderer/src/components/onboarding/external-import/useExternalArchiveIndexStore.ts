/**
 * 本机外部档案索引版本号——导入完成/删仓清档案后 bump，侧栏归组钩子据此重拉。
 */

import { create } from 'zustand'

interface ExternalArchiveIndexState {
  version: number
  bump: () => void
}

export const useExternalArchiveIndexStore = create<ExternalArchiveIndexState>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))
