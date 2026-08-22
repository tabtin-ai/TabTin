import type { AutoSaveController, AutoSaveControllerOptions, DocumentSavePayload } from '../types.js'
import { getDocEditorHost } from '../runtime/hostRegistry.js'
import { markdownToPlaintext } from './plaintext.js'
import { recordProbeEvent } from '../probe/dataflowProbe.js'

const DEFAULT_DEBOUNCE_MS = 1200
const DEFAULT_RETRY_DELAY_MS = 3000
const DEFAULT_MAX_RETRY_COUNT = 3

export const createAutoSaveController = (input: AutoSaveControllerOptions): AutoSaveController => {
  const host = input.host ?? getDocEditorHost()
  const now = host.now ?? (() => Date.now())
  const debounceMs = Math.max(0, input.debounceMs ?? DEFAULT_DEBOUNCE_MS)
  const retryDelayMs = Math.max(0, input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
  const maxRetryCount = Math.max(0, input.maxRetryCount ?? DEFAULT_MAX_RETRY_COUNT)

  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  let saving = false
  let cancelled = false
  let suspended = false
  let lastError: Error | null = null
  let retryCount = 0
  let changeSeq = 0
  let flushResolvers: Array<() => void> = []

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const buildPayload = (): DocumentSavePayload => {
    const draft = input.getDraft()
    return {
      baseVersion: input.getBaseVersion(),
      pmJson: draft.pmJson ?? {},
      markdown: draft.markdown ?? '',
      plaintext: draft.plaintext ?? markdownToPlaintext(draft.markdown ?? ''),
    }
  }

  const saveNow = async (): Promise<void> => {
    if (!dirty || saving || cancelled) {
      return
    }

    saving = true
    lastError = null
    const startedAt = now()
    const saveSeq = changeSeq
    let saveSucceeded = false
    let retryScheduled = false

    recordProbeEvent({
      component: 'autosave',
      event: 'save.start',
      payload: { baseVersion: input.getBaseVersion(), saveSeq, retryCount },
    })

    try {
      const result = await input.save(buildPayload())
      saveSucceeded = true
      retryCount = 0
      if (changeSeq === saveSeq) {
        dirty = false
      } else {
        dirty = true
      }
      if (!cancelled) {
        input.onSaved?.({
          ...result,
          savedAt: result.savedAt ?? now(),
        })
        host.track?.('doc_editor.autosave.success', {
          durationMs: Math.max(0, now() - startedAt),
          version: result.version,
        })
        recordProbeEvent({
          component: 'autosave',
          event: 'save.success',
          payload: {
            version: result.version,
            revisionId: result.revisionId,
            durationMs: Math.max(0, now() - startedAt),
          },
        })
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      lastError = normalized
      dirty = true

      if (cancelled) return

      // E2E-10: 冲突检测仅依赖 HTTP status code 和 error_code，不依赖 message 文本
      const errorObj = normalized as Error & { status?: number; statusCode?: number; code?: string; errorCode?: string }
      const errorStatus = errorObj.status ?? errorObj.statusCode
      const errorCode = errorObj.code ?? errorObj.errorCode ?? ''
      const isVersionConflict =
        errorStatus === 409 ||
        errorCode === 'VERSION_CONFLICT' ||
        errorCode === 'version_conflict'

      if (isVersionConflict && input.onConflict && retryCount < maxRetryCount) {
        retryCount += 1
        host.track?.('doc_editor.autosave.conflict_recovery', {
          durationMs: Math.max(0, now() - startedAt),
          retryCount,
        })
        recordProbeEvent({
          component: 'autosave',
          event: 'save.conflict',
          payload: { retryCount, errorStatus, errorCode },
        })
        try {
          const resolution = await input.onConflict()
          const action = resolution?.action ?? 'retry'
          if (!cancelled && action === 'retry') {
            clearTimer()
            timer = setTimeout(() => {
              timer = null
              void saveNow()
            }, 200)
            retryScheduled = true
          } else if (!cancelled && action === 'resolved') {
            // The host has durably preserved the divergent draft and applied the
            // authoritative document.  Do not retry the old payload against its
            // new base version: that would silently overwrite remote content.
            dirty = changeSeq !== saveSeq
            retryCount = 0
            lastError = null
            recordProbeEvent({
              component: 'autosave',
              event: 'save.conflict_resolved',
              payload: { errorStatus, errorCode },
            })
          } else if (!cancelled && action === 'blocked') {
            // Keep the in-memory/IndexedDB draft intact, but stop the generic
            // retry/error path. The host owns recovery UI and retry policy.
            suspended = true
            recordProbeEvent({
              component: 'autosave',
              event: 'save.conflict_blocked',
              payload: { errorStatus, errorCode },
            })
          }
        } catch (conflictError) {
          if (!cancelled) {
            const conflictNormalized = conflictError instanceof Error
              ? conflictError
              : normalized
            input.onError?.(conflictNormalized)
            host.notify?.({
              level: 'error',
              message: conflictNormalized.message || '自动保存失败',
            })
          }
        }
      } else {
        input.onError?.(normalized)
        host.notify?.({
          level: 'error',
          message: normalized.message || '自动保存失败',
        })
        host.track?.('doc_editor.autosave.failed', {
          durationMs: Math.max(0, now() - startedAt),
          message: normalized.message,
        })
        recordProbeEvent({
          component: 'autosave',
          event: 'save.failed',
          payload: {
            message: normalized.message,
            errorStatus,
            errorCode,
            durationMs: Math.max(0, now() - startedAt),
            retryCount,
          },
        })
        if (retryCount < maxRetryCount) {
          retryCount += 1
          clearTimer()
          timer = setTimeout(() => {
            timer = null
            void saveNow()
          }, retryDelayMs)
          retryScheduled = true
        }
      }
    } finally {
      saving = false
      const resolvers = flushResolvers
      flushResolvers = []
      if (resolvers.length > 0) {
        // CAP-024: 有 flush 等待者时让其处理后续保存，
        // 不在此处 schedule() 避免 debounceMs=0 时竞态
        resolvers.forEach(r => r())
      } else if (saveSucceeded && !retryScheduled && !cancelled && !suspended && dirty && !timer && retryCount === 0) {
        schedule()
      }
    }
  }

  const schedule = () => {
    if (cancelled || suspended) return
    clearTimer()
    if (debounceMs === 0) {
      void saveNow()
      return
    }
    timer = setTimeout(() => {
      timer = null
      if (!suspended) void saveNow()
    }, debounceMs)
  }

  // EC-06: 网络恢复时重置重试计数并重新调度
  const handleOnline = () => {
    if (dirty && retryCount >= maxRetryCount && !saving && !timer && !cancelled) {
      retryCount = 0
      schedule()
    }
  }

  if (typeof globalThis !== 'undefined' && typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('online', handleOnline)
  }

  return {
    markDirty: () => {
      if (cancelled) return
      dirty = true
      retryCount = 0
      changeSeq += 1
      recordProbeEvent({
        component: 'autosave',
        event: 'edit.markDirty',
        payload: { changeSeq },
      })
      schedule()
    },
    flush: async () => {
      clearTimer()
      // CAP-025: while 循环确保并发 flush 串行等待，
      // 避免多个 flush 同时看到 saving=false 后只有一个实际保存
      while (saving) {
        await new Promise<void>(resolve => {
          flushResolvers.push(resolve)
        })
      }
      if (dirty && !cancelled) {
        await saveNow()
      }
    },
    cancel: () => {
      clearTimer()
      dirty = false
      cancelled = true
      // 唤醒所有等待的 flush 调用方，使其不再阻塞
      const resolvers = flushResolvers
      flushResolvers = []
      resolvers.forEach(r => r())
      if (typeof globalThis !== 'undefined' && typeof globalThis.removeEventListener === 'function') {
        globalThis.removeEventListener('online', handleOnline)
      }
    },
    suspend: () => {
      suspended = true
      clearTimer()
    },
    resume: () => {
      suspended = false
      if (dirty && !saving && !timer && !cancelled) {
        schedule()
      }
    },
    discardPendingDraft: () => {
      clearTimer()
      dirty = false
      retryCount = 0
      lastError = null
      suspended = false
    },
    isDirty: () => dirty,
    isSaving: () => saving,
    getLastError: () => lastError,
  }
}
