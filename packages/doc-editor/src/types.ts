export type DocPermissionRole = 'viewer' | 'editor' | 'admin'

/**
 * TabDoc 协作连接参数（客户端通过 collab-core parameters 发送给 collab-live）。
 * 服务端据此进行 schema 兼容性校验。
 */
export interface DocCollabConnectionParams {
  /** 客户端 schema 版本号（对应 DOC_SCHEMA_VERSION） */
  schemaVersion: string
}

export interface DocumentContentDraft {
  pmJson: Record<string, unknown>
  markdown: string
  plaintext?: string
}

export interface DocumentSavePayload extends DocumentContentDraft {
  baseVersion: number | null
}

export interface DocumentSaveResult {
  version: number
  savedAt?: number
  revisionId?: string
}

/** How an autosave version conflict was handled by the host application. */
export type AutoSaveConflictResolution =
  | { action: 'retry' }
  | { action: 'resolved' }
  | { action: 'blocked' }

export interface DocEditorNotification {
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
}

export interface UploadFileInput {
  file: Blob
  filename?: string
  mimeType?: string
}

export interface UploadFileResult {
  url: string
  id?: string
  metadata?: Record<string, unknown>
}

export interface DocEditorHostAdapters {
  getAccessToken?: () => Promise<string | null> | string | null
  uploadFile?: (input: UploadFileInput) => Promise<UploadFileResult>
  notify?: (payload: DocEditorNotification) => void
  track?: (eventName: string, payload?: Record<string, unknown>) => void
  now?: () => number
}

export interface AutoSaveControllerOptions {
  getDraft: () => DocumentContentDraft
  getBaseVersion: () => number | null
  save: (payload: DocumentSavePayload) => Promise<DocumentSaveResult>
  onSaved?: (result: DocumentSaveResult) => void
  onError?: (error: Error) => void
  /**
   * 版本冲突时调用，实现方应刷新文档版本（更新 getBaseVersion 返回的值）。
   * 如果提供此回调，autosave 会在冲突后等待刷新完成并重试保存。
   * 控制器通过 getBaseVersion() 获取最新版本，无需此回调返回版本号。
   */
  onConflict?: () => Promise<AutoSaveConflictResolution | void>
  debounceMs?: number
  retryDelayMs?: number
  maxRetryCount?: number
  host?: DocEditorHostAdapters
}

export interface AutoSaveController {
  markDirty: () => void
  flush: () => Promise<void>
  cancel: () => void
  /** 暂停自动保存调度（markDirty 仍标记脏位，但不触发 timer）；flush() 仍可显式调用 */
  suspend: () => void
  /** 恢复自动保存调度，若有脏数据则立即排程 */
  resume: () => void
  /** Discard the current scheduled payload after the host has preserved it elsewhere. */
  discardPendingDraft: () => void
  isDirty: () => boolean
  isSaving: () => boolean
  getLastError: () => Error | null
}
