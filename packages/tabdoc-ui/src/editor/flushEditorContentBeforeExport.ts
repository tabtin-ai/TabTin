import type { AppHostClient } from '@tabtin/app-host-sdk'
import { getDocument, saveContent, type TabdocDocument } from '../api-client'

export interface ExportSaveBaseline {
  baseVersion: number | null
  baseUpdatedAt: string | null
}

export interface EditorContentSnapshot {
  pmJson: Record<string, unknown>
  markdown: string
  plaintext: string
}

export interface FlushEditorContentBeforeExportParams {
  client: AppHostClient
  documentId: string
  /** false 时跳过 flush（只读） */
  canEdit: boolean
  getEditorSnapshot: () => EditorContentSnapshot | null
  /** 与自动保存同源的 CAS baseline（优先 ref，避免 React 状态滞后） */
  getSaveBaseline: () => ExportSaveBaseline
  /** 冲突或主动对齐时回写本地 baseline（通常接到 patchCurrentDocument） */
  applyBaseline: (updates: Partial<TabdocDocument>) => void
  /** 版本冲突刷新后最多再试几次（默认 1，合计最多 2 次 save） */
  maxConflictRetries?: number
}

export function isTabDocVersionConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    if (typeof error === 'string') {
      return /版本冲突|version conflict/i.test(error)
    }
    return false
  }
  const candidate = error as {
    status?: number
    statusCode?: number
    code?: string
    errorCode?: string
    message?: string
  }
  const status = candidate.status ?? candidate.statusCode
  const code = candidate.code ?? candidate.errorCode ?? ''
  if (status === 409 || code === 'VERSION_CONFLICT' || code === 'version_conflict') {
    return true
  }
  const message = candidate.message
    ?? (error instanceof Error ? error.message : '')
  return /版本冲突|version conflict/i.test(message)
}

async function refreshSaveBaseline(
  client: AppHostClient,
  documentId: string,
  applyBaseline: (updates: Partial<TabdocDocument>) => void,
  fallback: ExportSaveBaseline,
): Promise<ExportSaveBaseline> {
  const detail = await getDocument(client, documentId)
  const document = detail.document
  if (!document) return fallback

  applyBaseline({
    latest_version: document.latest_version,
    updated_at: document.updated_at,
  })
  return {
    baseVersion: document.latest_version ?? null,
    // 刚拉过最新文档后只靠 version CAS。带上 client 侧 updated_at 易因
    // 精度/时区打出「当前版本 N，提交版本 N」伪冲突（见 ）。
    baseUpdatedAt: null,
  }
}

/**
 * 导出前把编辑器正文 flush 到服务端。
 * 使用与 autosave 同源的 baseline；409 时拉最新版本后重试，避免「已同步」却带着过期版本号导出失败。
 */
export async function flushEditorContentBeforeExport(
  params: FlushEditorContentBeforeExportParams,
): Promise<void> {
  const {
    client,
    documentId,
    canEdit,
    getEditorSnapshot,
    getSaveBaseline,
    applyBaseline,
    maxConflictRetries = 1,
  } = params

  if (!canEdit) return

  const snapshot = getEditorSnapshot()
  if (!snapshot) return

  let baseline = getSaveBaseline()
  let attempt = 0
  const maxRetries = Math.max(0, maxConflictRetries)

  for (;;) {
    try {
      const result = await saveContent(client, documentId, {
        baseVersion: baseline.baseVersion,
        baseUpdatedAt: baseline.baseUpdatedAt,
        pmJson: snapshot.pmJson,
        markdown: snapshot.markdown,
        plaintext: snapshot.plaintext,
      })
      applyBaseline(result.document)
      return
    } catch (error) {
      if (!isTabDocVersionConflictError(error) || attempt >= maxRetries) {
        throw error
      }
      attempt += 1
      baseline = await refreshSaveBaseline(
        client,
        documentId,
        applyBaseline,
        getSaveBaseline(),
      )
    }
  }
}
