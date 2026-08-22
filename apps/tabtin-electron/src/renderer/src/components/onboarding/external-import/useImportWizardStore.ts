/**
 * 外部 Agent 导入页的全局导航 store（Layer D）。
 *
 * 导入流程已改为内嵌全屏 App 页（`AppFullPageHost` → `ExternalImportPanel`）。
 * 保留 `open` / `close` 以兼容进度面板等历史调用点。
 */

import { create } from 'zustand'
import { useAppPageStore } from '@stores/useAppPageStore'
import { openImportHub } from '@/services/agentMemoryNavigation'

interface ImportWizardStore {
  open: () => void
  close: () => void
}

export const useImportWizardStore = create<ImportWizardStore>(() => ({
  open: () => openImportHub(),
  close: () => useAppPageStore.getState().closeAppPage(),
}))
