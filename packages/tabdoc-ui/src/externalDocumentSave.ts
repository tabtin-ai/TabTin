/**
 * 外部 save-content / REST 写入后，已打开编辑器如何 reconcile。
 *
 * 健康协作态（SYNCED/SYNCING）依赖 Yjs；断线 / 缺 token / 降级时靠
 * doc.events.save + REST 回拉（，延续  韧性缺口）。
 */

export type CollabStatusLike =
  | 'initial'
  | 'connecting'
  | 'syncing'
  | 'synced'
  | 'disconnected'
  | 'force-closed'
  | (string & {})

/** 健康协作：外部写入继续交给 Yjs，不做 REST 覆盖。 */
export function isHealthyCollabStatus(
  status: CollabStatusLike | null | undefined,
): boolean {
  return status === 'synced' || status === 'syncing'
}

/** 协作认证 token 缺失（本项目 lastError 或上游文案）。 */
export function isMissingCollabTokenError(
  lastError: string | null | undefined,
): boolean {
  if (!lastError) return false
  const normalized = lastError.toLowerCase()
  return (
    normalized === 'missing_collab_token'
    || normalized.includes('missing authentication token')
    || normalized.includes('no authentication token')
  )
}

export function shouldReconcileExternalDocumentSave(params: {
  incomingVersion: unknown
  localVersion: number | null | undefined
  saveState: string
}): boolean {
  const { incomingVersion, localVersion, saveState } = params
  if (typeof incomingVersion !== 'number' || !Number.isFinite(incomingVersion)) {
    return false
  }
  if (saveState === 'saving') {
    return false
  }
  const local = localVersion ?? 0
  return incomingVersion > local
}

export function shouldReconcileExternalDocumentSaveForMode(params: {
  syncMode: 'collab' | 'legacy'
  incomingVersion: unknown
  localVersion: number | null | undefined
  saveState: string
  /** 实际协作健康状态；仅看名义 syncMode='collab' 会漏断线场景 */
  collabStatus?: CollabStatusLike | null
  collabLastError?: string | null
}): boolean {
  if (!shouldReconcileExternalDocumentSave(params)) {
    return false
  }

  // 已降级 / 单人模式：始终 REST 回拉
  if (params.syncMode === 'legacy') {
    return true
  }

  // 健康协作：依赖 Yjs
  if (isHealthyCollabStatus(params.collabStatus)) {
    return false
  }

  // DISCONNECTED / FORCE_CLOSED / INITIAL / CONNECTING / 缺 token → REST
  return true
}

/** 可重连协作才 forceReconnect；FORCE_CLOSED / 缺 token 只靠 REST。 */
export function canForceReconnectAfterExternalSave(params: {
  collabEnabled: boolean
  isFallback: boolean
  collabStatus?: CollabStatusLike | null
  collabLastError?: string | null
}): boolean {
  if (!params.collabEnabled || params.isFallback) {
    return false
  }
  if (params.collabStatus === 'force-closed') {
    return false
  }
  if (isMissingCollabTokenError(params.collabLastError)) {
    return false
  }
  return true
}

export interface ExternalDocumentSaveReconcileOptions {
  retryLoad: () => void
  triggerForceReconnect: () => void
  collabEnabled: boolean
  isFallback: boolean
  /**
   * 可重连时才 forceReconnect。
   * FORCE_CLOSED / 永久失败传 false；省略时回退为 collabEnabled && !isFallback。
   */
  canForceReconnect?: boolean
}

/** 拉 REST 快照；可重连的协作态额外 forceReconnect，与 checkpoint 回滚路径对齐。 */
export function applyExternalDocumentSaveReconcile(
  options: ExternalDocumentSaveReconcileOptions,
): void {
  options.retryLoad()
  const canReconnect = options.canForceReconnect
    ?? (options.collabEnabled && !options.isFallback)
  if (canReconnect) {
    options.triggerForceReconnect()
  }
}
