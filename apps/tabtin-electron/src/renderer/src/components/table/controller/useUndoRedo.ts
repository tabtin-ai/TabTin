/**
 * Electron-specific wrapper: injects collab undo/redo from the global collab store.
 */

import {
  useUndoRedo as useUndoRedoShared,
  type UseUndoRedoInput as SharedInput,
  type UseUndoRedoResult,
} from '@tabtin/table-ui'
import { useCollabUndoRedoForTable } from '@stores/useTableCollabStore'
import { useRecordStore } from '@stores/useRecordStore'

export type UseUndoRedoInput = Omit<SharedInput, 'collabUndoRedo' | 'dataVersion'> & {
  /** 当前 TableCollabContext 的 surface-local 入口；嵌入表不再依赖全局 last-writer。 */
  collabUndoRedo?: SharedInput['collabUndoRedo']
}
export type { UseUndoRedoResult }

export function useUndoRedo(input: UseUndoRedoInput): UseUndoRedoResult {
  const globalCollabUndoRedo = useCollabUndoRedoForTable(input.selectedTableId)
  const collabUndoRedo = input.collabUndoRedo ?? globalCollabUndoRedo
  // records 引用在每次本地记录 CRUD 落库后都会换新，作为离线/降级态的“数据已变更”信号，
  // 驱动 useUndoRedoCore 去重刷新后端撤回栈，编辑后按钮才能及时点亮。
  const records = useRecordStore((state) => state.records)
  return useUndoRedoShared({
    ...input,
    collabUndoRedo,
    dataVersion: records,
    skipRecordsRefreshOnStackOperation: collabUndoRedo.isOnline,
  })
}
