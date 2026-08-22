import { useEffect, useRef, useCallback, useState } from 'react'
import {
  RecordApiService,
  ViewApiService,
  buildVersionEtag,
  coerceMonotonicVersionToken,
  normalizeViewFiltersForBackend,
  withTableRequestHeaders,
  type TableRecord,
} from '@tabtin/table-core'
import type { IncrementalSyncSnapshot } from './types'

export interface UseIncrementalSyncOptions {
  tableId: string | null
  viewId?: string | null
  latestVersion: number | null
  syncEtag?: string | null
  onUpdate: (records: TableRecord[], newVersion: number, snapshot?: IncrementalSyncSnapshot) => void
  onFullReloadRequired?: () => void | Promise<void>
  pollInterval?: number
  pollTimeout?: number
  enabled?: boolean
  mode?: 'table' | 'view'
  viewQuery?: Record<string, unknown>
  /** 与表格其它 HTTP 请求一致的宿主访问上下文。 */
  requestHeaders?: Record<string, string>
}

export function runIncrementalRequest<T>(
  requestHeaders: Record<string, string> | undefined,
  operation: () => T,
): T {
  return requestHeaders
    ? withTableRequestHeaders(requestHeaders, operation)
    : operation()
}

export async function handleIncrementalFullReloadSignal(
  response: unknown,
  onFullReloadRequired?: () => void | Promise<void>,
): Promise<boolean> {
  if (
    !response
    || typeof response !== 'object'
    || !('requires_full_reload' in response)
    || response.requires_full_reload !== true
  ) return false
  if (!onFullReloadRequired) {
    throw new Error('Incremental sync requires a full reload handler')
  }
  await onFullReloadRequired()
  return true
}

export function useIncrementalSync(options: UseIncrementalSyncOptions) {
  const {
    tableId,
    viewId = null,
    latestVersion,
    syncEtag = null,
    onUpdate,
    onFullReloadRequired,
    pollInterval = 3000,
    pollTimeout = 60000,
    enabled = true,
    mode = 'table',
    viewQuery,
    requestHeaders,
  } = options

  const [state, setState] = useState({
    isPolling: false,
    pendingCount: 0,
    error: null as string | null,
  })

  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingFieldsRef = useRef<Set<string>>(new Set())
  const retryCountRef = useRef(0)
  const checkingRef = useRef(false)
  const isPollingRef = useRef(false)
  const pollingStartTimeRef = useRef<number | null>(null)
  const activePollTimeoutRef = useRef(pollTimeout)
  const abortControllerRef = useRef<AbortController | null>(null)
  const checkForUpdatesRef = useRef<() => Promise<void>>(async () => {})

  const pollIntervalRef = useRef(pollInterval)
  pollIntervalRef.current = pollInterval
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const onFullReloadRequiredRef = useRef(onFullReloadRequired)
  onFullReloadRequiredRef.current = onFullReloadRequired

  const stopPolling = useCallback(() => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current)
      pollingTimerRef.current = null
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    isPollingRef.current = false
    pollingStartTimeRef.current = null
    activePollTimeoutRef.current = pollTimeout
    setState(prev => ({ ...prev, isPolling: false, pendingCount: 0 }))
    pendingFieldsRef.current.clear()
    retryCountRef.current = 0
  }, [pollTimeout])

  const checkForUpdates = useCallback(async () => {
    const normalizedVersion = coerceMonotonicVersionToken(latestVersion)
    if (normalizedVersion == null || !enabled) return
    if (mode === 'table' && !tableId) return
    if (mode === 'view' && !viewId) return
    if (checkingRef.current) return
    checkingRef.current = true
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }

    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      if (
        pollingStartTimeRef.current &&
        Date.now() - pollingStartTimeRef.current > activePollTimeoutRef.current
      ) {
        stopPolling()
        setState(prev => ({ ...prev, error: 'Incremental sync timeout' }))
        return
      }

      const normalizedViewFilters = normalizeViewFiltersForBackend(
        viewQuery?.filters as Parameters<typeof normalizeViewFiltersForBackend>[0]
      )
      const conditionalEtag = (typeof syncEtag === 'string' && syncEtag.trim().length > 0)
        ? syncEtag.trim()
        : buildVersionEtag(normalizedVersion)

      const requestUpdates = () => mode === 'view'
        ? ViewApiService.getViewRecords(viewId as string, {
          ...viewQuery,
          filters: normalizedViewFilters,
          field_key_type: 'id',
          since_version: normalizedVersion,
          only_delta: true,
          page_size: (viewQuery?.page_size as number | undefined) ?? 100,
          ifNoneMatch: conditionalEtag,
        })
        : RecordApiService.getRecordsByTable(tableId as string, {
          field_key_type: 'id',
          since_version: normalizedVersion,
          only_delta: true,
          page_size: 100,
          ifNoneMatch: conditionalEtag,
        })
      const result = await runIncrementalRequest(requestHeaders, requestUpdates)

      if (controller.signal.aborted) return

      if (result.status === 304) {
        retryCountRef.current = 0
        return
      }

      if (result.status === 200 && result.data) {
        const handledFullReload = await handleIncrementalFullReloadSignal(
          result.data,
          onFullReloadRequiredRef.current,
        )
        if (controller.signal.aborted || abortControllerRef.current !== controller) return
        if (handledFullReload) {
          stopPolling()
          retryCountRef.current = 0
          return
        }
        const { records, latest_version, total } = result.data
        const metadata =
          mode === 'view'
            ? (result.data as { metadata?: Record<string, unknown> }).metadata
            : undefined
        if (typeof latest_version === 'number') {
          console.log(`[IncrementalSync] 收到 ${records.length} 条记录 (v${normalizedVersion}→v${latest_version}, total=${total})`)
          onUpdateRef.current(records, latest_version, {
            total,
            metadata,
          })

          if (records.length > 0 && pendingFieldsRef.current.size > 0) {
            const updatedRecordIds = new Set(records.map((r: any) => r.id))
            for (const pendingKey of [...pendingFieldsRef.current]) {
              const sep = pendingKey.indexOf('_')
              if (sep > 0 && updatedRecordIds.has(pendingKey.slice(0, sep))) {
                pendingFieldsRef.current.delete(pendingKey)
              }
            }
            setState(prev => ({ ...prev, pendingCount: pendingFieldsRef.current.size }))
            if (pendingFieldsRef.current.size === 0) stopPolling()
          }
        }
        retryCountRef.current = 0
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (controller.signal.aborted) return
      console.error('[useIncrementalSync] checkForUpdates failed:', error)
      retryCountRef.current++
      if (retryCountRef.current >= 3) {
        stopPolling()
        setState(prev => ({ ...prev, error: 'Too many retries' }))
      } else if (!isPollingRef.current && !retryTimerRef.current) {
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null
          void checkForUpdatesRef.current()
        }, pollIntervalRef.current)
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
        checkingRef.current = false
      }
    }
  }, [tableId, viewId, latestVersion, syncEtag, enabled, mode, viewQuery, requestHeaders, stopPolling])

  checkForUpdatesRef.current = checkForUpdates

  const triggerSync = useCallback(async () => {
    await checkForUpdatesRef.current()
  }, [])

  const startPolling = useCallback((pendingFields?: Set<string>) => {
    if (!enabled) return
    if (pendingFields) {
      pendingFields.forEach(key => pendingFieldsRef.current.add(key))
    }
    if (isPollingRef.current) {
      setState(prev => ({ ...prev, pendingCount: pendingFieldsRef.current.size }))
      return
    }
    isPollingRef.current = true
    const dynamicTimeout = Math.min(
      300000,
      Math.max(60000, pendingFieldsRef.current.size * 30),
    )
    activePollTimeoutRef.current = dynamicTimeout
    pollingStartTimeRef.current = Date.now()
    setState(prev => ({ ...prev, isPolling: true, pendingCount: pendingFieldsRef.current.size, error: null }))
    void checkForUpdatesRef.current()
    pollingTimerRef.current = setInterval(() => {
      void checkForUpdatesRef.current()
    }, pollIntervalRef.current)
    retryCountRef.current = 0
  }, [enabled])

  const markFieldComplete = useCallback((recordId: string, fieldId: string) => {
    pendingFieldsRef.current.delete(`${recordId}_${fieldId}`)
    setState(prev => ({ ...prev, pendingCount: pendingFieldsRef.current.size }))
    if (pendingFieldsRef.current.size === 0) stopPolling()
  }, [stopPolling])

  useEffect(() => {
    retryCountRef.current = 0
    return () => {
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
      checkingRef.current = false
      stopPolling()
    }
  }, [tableId, viewId, mode, stopPolling])

  useEffect(() => {
    return () => {
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current)
        pollingTimerRef.current = null
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      abortControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (pollingTimerRef.current) {
          clearInterval(pollingTimerRef.current)
          pollingTimerRef.current = null
        }
      } else if (isPollingRef.current && pendingFieldsRef.current.size > 0) {
        if (pollingTimerRef.current) clearInterval(pollingTimerRef.current)
        pollingTimerRef.current = setInterval(() => {
          void checkForUpdatesRef.current()
        }, pollIntervalRef.current)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  return {
    isPolling: state.isPolling,
    pendingCount: state.pendingCount,
    error: state.error,
    startPolling,
    stopPolling,
    triggerSync,
    markFieldComplete,
  }
}
