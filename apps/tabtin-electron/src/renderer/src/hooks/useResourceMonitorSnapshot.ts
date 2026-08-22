import React, { startTransition } from 'react'
import type {
  ResourceMonitorSnapshot,
  ResourceMonitorSnapshotMode,
} from '@shared/types/resource-monitor'
import {
  recordResourceMonitorHistorySnapshot,
  useResourceMonitorHistory,
  type ResourceMonitorHistoryState,
} from '@components/resource-monitor/history'

const POLL_INTERVAL_MS: Record<ResourceMonitorSnapshotMode, number> = {
  interactive: 2000,
  idle: 15000,
}

/**
 * 手动刷新（force=true）的最小可见时长：本机快照走进程内 IPC，往返常在几十毫秒内完成，
 * `isRefreshing` 一闪而过会让刷新图标转不起来、用户感知不到「重新刷了一遍」。
 * 仅对用户主动触发的刷新做这个保底，不影响后台自动轮询的实时性。
 */
const MIN_MANUAL_REFRESH_VISIBLE_MS = 800

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message
  return '资源快照获取失败'
}

export interface UseResourceMonitorSnapshotResult {
  snapshot: ResourceMonitorSnapshot | null
  history: ResourceMonitorHistoryState
  isLoading: boolean
  isRefreshing: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useResourceMonitorSnapshot(
  mode: ResourceMonitorSnapshotMode,
): UseResourceMonitorSnapshotResult {
  const [snapshot, setSnapshot] = React.useState<ResourceMonitorSnapshot | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [isRefreshing, setIsRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const snapshotRef = React.useRef<ResourceMonitorSnapshot | null>(null)
  const history = useResourceMonitorHistory(mode)

  React.useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  const loadSnapshot = React.useCallback(async (force: boolean) => {
    if (!window.tabtin?.resourceMonitor?.getSnapshot) {
      setError('当前版本暂不支持资源监控')
      setIsLoading(false)
      setIsRefreshing(false)
      return
    }

    const isManualRefresh = force
    // 仅手动刷新展示 isRefreshing（转圈/变淡）；后台轮询必须静默，否则每 2s 会闪一次
    if (!snapshotRef.current && !force) {
      setIsLoading(true)
    } else if (isManualRefresh) {
      setIsRefreshing(true)
    }

    const startedAt = Date.now()
    try {
      const nextSnapshot = await window.tabtin.resourceMonitor.getSnapshot({
        mode,
        force,
      })
      recordResourceMonitorHistorySnapshot(nextSnapshot)
      startTransition(() => {
        setSnapshot(nextSnapshot)
        setError(null)
      })
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      if (isManualRefresh) {
        const remainingMs = MIN_MANUAL_REFRESH_VISIBLE_MS - (Date.now() - startedAt)
        if (remainingMs > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, remainingMs))
        }
        setIsRefreshing(false)
      }
      setIsLoading(false)
    }
  }, [mode])

  React.useEffect(() => {
    let disposed = false
    let timerId: number | null = null

    const schedule = () => {
      timerId = window.setTimeout(() => {
        void tick(false)
      }, POLL_INTERVAL_MS[mode])
    }

    const tick = async (force: boolean) => {
      if (disposed) return
      await loadSnapshot(force)
      if (!disposed) {
        schedule()
      }
    }

    void tick(false)

    return () => {
      disposed = true
      if (timerId !== null) {
        window.clearTimeout(timerId)
      }
    }
  }, [mode, loadSnapshot])

  const refresh = React.useCallback(async () => {
    await loadSnapshot(true)
  }, [loadSnapshot])

  return {
    snapshot,
    history,
    isLoading,
    isRefreshing,
    error,
    refresh,
  }
}
