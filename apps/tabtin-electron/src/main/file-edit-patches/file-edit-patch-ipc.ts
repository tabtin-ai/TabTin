/**
 * 编辑工具补丁账本 IPC。
 *
 * 正文只留本机 jsonl；file-history IPC 仍只负责备份一致性 / 回退预览，
 * 不作为 Agent Turn 逐行 Diff 的来源（回合内用户手改会污染 rewind diff）。
 */
import { guardedHandle } from '../utils/guarded-handle'
import { createLogger } from '../logger'
import { readFileEditPatch, type FileEditPatch } from '@tabtin/agent-host/tools'
import {
  listFileEditPatchRecords,
  recordFileEditPatch,
} from './file-edit-patch-store'

const log = createLogger('FileEditPatchIPC')

export function registerFileEditPatchIpcHandlers(): void {
  guardedHandle('file-edit-patches:list', async (_event, threadId: string) => {
    if (typeof threadId !== 'string' || !threadId.trim()) {
      return { success: false as const, error: 'threadId is required', records: [] as const }
    }
    try {
      const records = await listFileEditPatchRecords(threadId)
      return { success: true as const, records }
    } catch (error) {
      log.warn('list editor patches failed', { threadId, error: String(error) })
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
        records: [] as const,
      }
    }
  })

  guardedHandle(
    'file-edit-patches:record',
    async (_event, threadId: string, toolUseId: string, patchRaw: unknown) => {
      if (typeof threadId !== 'string' || !threadId.trim()) {
        return { success: false as const, error: 'threadId is required' }
      }
      if (typeof toolUseId !== 'string' || !toolUseId.trim()) {
        return { success: false as const, error: 'toolUseId is required' }
      }
      const patch = readFileEditPatch({ fileEditPatch: patchRaw })
      if (!patch) {
        return { success: false as const, error: 'invalid file edit patch' }
      }
      try {
        await recordFileEditPatch({
          threadId,
          toolUseId,
          patch: patch as FileEditPatch,
        })
        return { success: true as const }
      } catch (error) {
        log.warn('record editor patch failed', { threadId, toolUseId, error: String(error) })
        return {
          success: false as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )
}
