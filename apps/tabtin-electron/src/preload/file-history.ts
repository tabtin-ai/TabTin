import { ipcRenderer } from 'electron'

/**
 * File-history（per-file 回退）renderer 桥接 —— 替代 shadow git 的 checkpoint.restore。
 *
 * 主进程 handler 见 `apps/tabtin-electron/src/main/file-history/file-history-ipc.ts`；
 * service 实例从 host 的 per-thread 缓存取。thread 没跑过 query / anchor 不存在时
 * 返 `{ success:false, error }`（绝不静默成功）。本次只把能力备好，前端回退编排
 * （executeRollbackPipeline 文件恢复段）后续接入。
 */
export interface FileHistoryRewindResult {
  /** 被还原内容的文件（绝对路径）。 */
  filesRestored: string[]
  /** 被删除的文件（绝对路径，目标版本下不存在）。 */
  filesDeleted: string[]
  /** 无法回退的文件（绝对路径）——备份缺失 / 非普通文件等，fail-visible 呈现给用户。 */
  failedFiles: string[]
}

export interface FileHistoryPreviewResult {
  success: boolean
  status: 'available' | 'not_applicable' | 'unavailable'
  paths: string[]
  reason?: 'no_file_anchor' | 'no_file_history' | 'no_file_changes' | 'file_snapshot_missing' | 'path_guard_denied' | 'preview_failed' | 'unrestorable_files'
  error?: string
  revision: string
  unrestorable: Array<{ path: string; reason: string; detail?: string }>
}

export interface FileHistoryApi {
  rewind: (
    threadId: string,
    anchorId: string,
    expectedPreviewRevision?: string,
  ) => Promise<
    | { success: true; result: FileHistoryRewindResult }
    | { success: false; error: string; reason?: string }
  >
  getAffectedPaths: (
    threadId: string,
    anchorId: string,
  ) => Promise<
    | { success: true; paths: string[] }
    | { success: false; error: string; paths: string[] }
  >
  /** 含当前/目标内容指纹的权威本机预览；编辑重发确认必须使用本结果。 */
  getPreview: (
    threadId: string,
    anchorId: string | null,
  ) => Promise<FileHistoryPreviewResult>
  /** 回退前 safety 快照：捕获当前 tracked 文件状态，供 unrevert 还原。 */
  createSafetySnapshot: (
    threadId: string,
    safetyAnchorId: string,
  ) => Promise<{ success: true } | { success: false; error: string }>
  /** 预览：回退到 anchor 的文件 diff（与 rewind 同 anchor，）。 */
  getRewindDiff: (
    threadId: string,
    anchorId: string,
  ) => Promise<
    | { success: true; diffs: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; before?: string; after?: string }> }
    | { success: false; error: string; diffs: [] }
  >
}

/** 创建 File-history IPC 桥接实现。 */
export function createFileHistoryApi(): FileHistoryApi {
  return {
    rewind: (threadId: string, anchorId: string, expectedPreviewRevision?: string) =>
      ipcRenderer.invoke('file-history:rewind', threadId, anchorId, expectedPreviewRevision),
    getAffectedPaths: (threadId: string, anchorId: string) =>
      ipcRenderer.invoke('file-history:getAffectedPaths', threadId, anchorId),
    getPreview: (threadId: string, anchorId: string | null) =>
      ipcRenderer.invoke('file-history:getPreview', threadId, anchorId),
    createSafetySnapshot: (threadId: string, safetyAnchorId: string) =>
      ipcRenderer.invoke('file-history:createSafetySnapshot', threadId, safetyAnchorId),
    getRewindDiff: (threadId: string, anchorId: string) =>
      ipcRenderer.invoke('file-history:getRewindDiff', threadId, anchorId),
  }
}
