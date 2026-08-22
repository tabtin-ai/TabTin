/**
 * 外部 Agent 导入——全局 onProgress 订阅挂载点（Layer D）。
 *
 * 挂在 AppLayout（与 UploadNotificationPanel 同区），建立**唯一**一次
 * `window.tabtin.import.onProgress` 订阅，把进度事件路由进 `useImportJobStore`。
 * 向导 UI 已迁至 `AppFullPageHost` → `ExternalImportPanel`。
 */

import React, { useEffect } from 'react'
import { useImportJobStore } from './useImportJobStore'

export const ExternalImportWizardHost: React.FC = () => {
  useEffect(() => {
    const api = window.tabtin?.import
    if (!api?.onProgress) return
    const unsubscribe = api.onProgress((evt) => {
      useImportJobStore.getState().applyProgress(evt)
    })
    return () => {
      try {
        unsubscribe()
      } catch {
        /* 卸载时取消订阅失败无害 */
      }
    }
  }, [])

  return null
}
