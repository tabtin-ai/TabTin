import { joinApiPath } from '@tabtin/config'

export interface LocalFileRestoreFinalResult {
  status: 'success' | 'not_applicable' | 'partial' | 'failed' | 'unavailable'
  reason: string | null
  failedFiles: string[]
  unrestorableFiles: Array<{ path: string; reason: string }>
}

export function resolvePendingFileRestoreApply(backend: unknown): {
  required: boolean
  applyId: string | null
  expiresAt: string | null
} {
  if (!backend || typeof backend !== 'object') {
    return { required: false, applyId: null, expiresAt: null }
  }
  const record = backend as Record<string, unknown>
  const applyResult = record.apply_result
  const applyId = applyResult && typeof applyResult === 'object'
    && typeof (applyResult as Record<string, unknown>).apply_id === 'string'
    ? String((applyResult as Record<string, unknown>).apply_id)
    : null
  return {
    required: record.file_restore_finalize_required === true,
    applyId,
    expiresAt: typeof record.file_restore_finalize_expires_at === 'string'
      ? record.file_restore_finalize_expires_at
      : null,
  }
}

export function mergeFinalizedFileRestoreBackend(
  pendingBackend: Record<string, unknown>,
  finalizedBackend: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...pendingBackend,
    ...finalizedBackend,
    // 初次 /rollback 的 pending 字段属于同一 apply 的中间态，不能泄漏进最终回执。
    file_restore_finalize_required: false,
    file_restore_finalize_expires_at: null,
    file_restore_coordinated_by_host: true,
    file_restore_host: 'local',
  }
}

export async function finalizeLocalFileRestore(input: {
  apiBaseUrl: string
  sessionId: string
  accessToken: string
  organizationId?: string
  applyId: string
  rollbackContractVersion: number
  previewRevision: string
  filePreviewRevision: string
  result: LocalFileRestoreFinalResult
  fetchImpl?: typeof fetch
  maxAttempts?: number
  retryDelayMs?: number
}): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string; data?: unknown }> {
  const fetchImpl = input.fetchImpl ?? fetch
  const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? 3, 5))
  const retryDelayMs = Math.max(0, input.retryDelayMs ?? 150)
  let lastFailure: { error: string; data?: unknown } = { error: 'file restore finalize failed' }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(
        joinApiPath(input.apiBaseUrl, `/chat/sessions/${encodeURIComponent(input.sessionId)}/rollback/files/finalize`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${input.accessToken}`,
            'X-Client-Type': 'electron',
            ...(input.organizationId ? { 'X-Organization-Id': input.organizationId } : {}),
          },
          body: JSON.stringify({
            apply_id: input.applyId,
            rollback_contract_version: input.rollbackContractVersion,
            preview_revision: input.previewRevision,
            file_preview_revision: input.filePreviewRevision,
            file_restore_status: input.result.status,
            file_restore_reason: input.result.reason,
            failed_files: input.result.failedFiles,
            unrestorable_files: input.result.unrestorableFiles,
          }),
        },
      )
      const body = await response.json().catch(() => null) as unknown
      if (response.ok) {
        const data = body && typeof body === 'object' && 'data' in body
          ? (body as { data?: unknown }).data
          : body
        return {
          ok: true,
          data: data && typeof data === 'object' ? data as Record<string, unknown> : {},
        }
      }
      const error = body && typeof body === 'object' && 'message' in body
        ? String((body as { message?: unknown }).message)
        : `HTTP ${response.status}`
      lastFailure = { error, data: body }
      // 冲突/校验失败是确定性拒绝；只有限流与服务端瞬时错误值得重试。
      if (response.status !== 429 && response.status < 500) {
        return { ok: false, ...lastFailure }
      }
    } catch (error) {
      lastFailure = { error: error instanceof Error ? error.message : String(error) }
    }
    if (attempt < maxAttempts && retryDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt))
    }
  }
  return { ok: false, ...lastFailure }
}
