import { useCallback, useState } from 'react'
import { useFolderContextStore } from '../folder/useFolderStore'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { contextRegistry } from '../registry'

export interface RemoveFolderConfirmState {
  open: boolean
  folderId: string
  title: string
}

const INITIAL: RemoveFolderConfirmState = { open: false, folderId: '', title: '' }

/**
 * 文件夹「移除」二次确认逻辑，从 ContextHome 中提取。
 * 返回 confirm state + 触发/执行/关闭回调。
 */
export function useRemoveFolderConfirm(spaceId: string) {
  const [confirmState, setConfirmState] = useState<RemoveFolderConfirmState>(INITIAL)

  const requestRemove = useCallback((folderId: string, title: string) => {
    setConfirmState({ open: true, folderId, title })
  }, [])

  const executeRemove = useCallback(() => {
    setConfirmState(prev => {
      if (!prev.folderId) return prev
      useFolderContextStore.getState().removeFolder(prev.folderId)
      if (spaceId) {
        const tabKey = contextRegistry.buildTabKey('tabfolder', prev.folderId)
        useSpaceContextTabsStore.getState().closeTab(spaceId, tabKey)
      }
      return INITIAL
    })
  }, [spaceId])

  const cancelRemove = useCallback(() => {
    setConfirmState(INITIAL)
  }, [])

  return { confirmState, requestRemove, executeRemove, cancelRemove } as const
}
