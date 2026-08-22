/**
 * 系统权限状态管理 Hook
 *
 * 职责：
 *  - 初次加载时拉全量状态
 *  - 窗口 focus / 从后台回到前台时自动刷新（用户从系统设置回来一眼看到变化）
 *  - 本页挂载期间短间隔静默轮询（并排改系统开关也能跟上；离页即停）
 *  - 提供单项操作：openSettings / request / recheck
 *  - 对「授权后需重启才刷新」的权限维护 UI 层 pendingRestartConfirmation
 *
 * 与主进程的 IPC 抽象：仅通过 window.tabtin.osPermissions.* 调用，
 * 不在这里假设 main 实现细节；不修改主进程 PermissionStatus enum。
 *
 * 生命周期：仅挂在「系统权限」面板；离开该 section 会卸载本 hook，
 * 必须清掉页级 interval 与单项轮询，避免残留定时器继续打 IPC。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import type { PermissionDescriptor, PermissionKind, PermissionStatus } from './permissionConfig'

/** 系统权限页挂载期间的静默全量刷新间隔（毫秒）。 */
export const PERMISSIONS_PAGE_POLL_INTERVAL_MS = 2000

interface OsPermissionsIpc {
  list?: () => Promise<PermissionDescriptor[]>
  check?: (kind: PermissionKind) => Promise<PermissionDescriptor>
  request?: (kind: PermissionKind) => Promise<PermissionStatus>
  openSettings?: (kind: PermissionKind) => Promise<boolean>
}

interface PermissionPollingState {
  token: number
  attempts: number
  running: boolean
  timer: ReturnType<typeof setInterval>
}

const PENDING_RESTART_STORAGE_KEY = 'tabtin:os-permissions:pending-restart'

function getIpc(): OsPermissionsIpc | null {
  if (typeof window === 'undefined') return null
  const tabtin = (window as unknown as { tabtin?: { osPermissions?: OsPermissionsIpc } }).tabtin
  return tabtin?.osPermissions ?? null
}

function canPollPermissionStatus(item: PermissionDescriptor | undefined): boolean {
  return (item?.detection ?? 'supported') !== 'unsupported'
}

function readPendingRestartKinds(): Set<PermissionKind> {
  if (typeof sessionStorage === 'undefined') return new Set()
  try {
    const raw = sessionStorage.getItem(PENDING_RESTART_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is PermissionKind => typeof item === 'string') as PermissionKind[])
  } catch {
    return new Set()
  }
}

function writePendingRestartKinds(kinds: Set<PermissionKind>): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(PENDING_RESTART_STORAGE_KEY, JSON.stringify([...kinds]))
  } catch {
    // sessionStorage 满/禁用时忽略，内存 ref 仍可用
  }
}

export type LoadState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

export interface UsePermissionsStateResult {
  items: PermissionDescriptor[]
  loadState: LoadState
  /** 手动「重新检查」进行中（与首次 loading 分开，避免 ready 时按钮无反馈） */
  isRefreshing: boolean
  errorMessage: string | null
  /** 当前平台（来自第一条记录，用于跨平台 UI 文案） */
  platform: NodeJS.Platform | null
  refresh: (opts?: { silent?: boolean }) => Promise<void>
  checkOne: (kind: PermissionKind) => Promise<PermissionDescriptor | null>
  request: (kind: PermissionKind) => Promise<void>
  openSettings: (kind: PermissionKind) => Promise<void>
}

export function usePermissionsState(): UsePermissionsStateResult {
  const { t } = useTranslation('settings')
  const [items, setItems] = useState<PermissionDescriptor[]>([])
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const itemsRef = useRef<PermissionDescriptor[]>(items)
  const inflightRef = useRef(false)
  const hasLoadedRef = useRef(false)
  const mountedRef = useRef(true)
  const pollingTokenRef = useRef(0)
  const pollingTimersRef = useRef(new Map<PermissionKind, PermissionPollingState>())
  const checkingKindsRef = useRef(new Set<PermissionKind>())
  const pendingRestartKindsRef = useRef<Set<PermissionKind>>(readPendingRestartKinds())
  const wasHiddenRef = useRef(false)
  itemsRef.current = items

  const persistPendingRestartKinds = useCallback(() => {
    writePendingRestartKinds(pendingRestartKindsRef.current)
  }, [])

  const applyPendingRestartState = useCallback((descriptor: PermissionDescriptor): PermissionDescriptor => {
    const detection = descriptor.detection ?? 'supported'
    if (
      detection === 'unsupported' ||
      descriptor.status === 'granted' ||
      descriptor.status === 'denied' ||
      descriptor.status === 'restricted' ||
      descriptor.status === 'unknown' ||
      descriptor.status === 'not-applicable'
    ) {
      pendingRestartKindsRef.current.delete(descriptor.kind)
      persistPendingRestartKinds()
    }

    const pendingRestartConfirmation =
      descriptor.requiresAppRestartAfterGrant === true &&
      descriptor.status === 'not-determined' &&
      detection !== 'unsupported' &&
      pendingRestartKindsRef.current.has(descriptor.kind)

    return {
      ...descriptor,
      pendingRestartConfirmation,
    }
  }, [persistPendingRestartKinds])

  const markPendingRestartIfNeeded = useCallback((kind: PermissionKind) => {
    const current = itemsRef.current.find((item) => item.kind === kind)
    if (
      current?.requiresAppRestartAfterGrant === true &&
      (current.detection ?? 'supported') !== 'unsupported' &&
      current.status !== 'granted' &&
      current.status !== 'not-applicable'
    ) {
      pendingRestartKindsRef.current.add(kind)
      persistPendingRestartKinds()
      setItems((prev) => prev.map((item) => (
        item.kind === kind ? applyPendingRestartState(item) : item
      )))
    }
  }, [applyPendingRestartState, persistPendingRestartKinds])

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      const ipc = getIpc()
      if (!ipc?.list) {
        if (!mountedRef.current) return
        setLoadState('unavailable')
        setItems([])
        return
      }
      if (inflightRef.current) return
      inflightRef.current = true

      const isManualRecheck = hasLoadedRef.current && !opts?.silent
      const startedAt = Date.now()
      if (isManualRecheck) {
        setIsRefreshing(true)
      } else if (!hasLoadedRef.current) {
        setLoadState('loading')
      }

      try {
        const list = (await ipc.list()).map(applyPendingRestartState)
        // 离页卸载后丢弃结果，避免 setState on unmounted hook / 残留轮询写回
        if (!mountedRef.current) return
        setItems(list)
        setLoadState('ready')
        setErrorMessage(null)
        hasLoadedRef.current = true
        if (isManualRecheck) {
          toast.success(t('authorizationSystem.overview.refreshDone'))
        }
      } catch (err) {
        console.error('[usePermissionsState] list 失败:', err)
        if (!mountedRef.current) return
        setErrorMessage(err instanceof Error ? err.message : String(err))
        setLoadState('error')
        if (isManualRecheck) {
          toast.error(t('authorizationSystem.errorTitle'))
        }
      } finally {
        if (isManualRecheck && mountedRef.current) {
          // 主进程 list 往往极快，保底转一会，避免「点了没反应」
          const elapsed = Date.now() - startedAt
          const remain = Math.max(0, 350 - elapsed)
          if (remain > 0) {
            await new Promise((resolve) => setTimeout(resolve, remain))
          }
        }
        inflightRef.current = false
        if (mountedRef.current) {
          setIsRefreshing(false)
        }
      }
    },
    [applyPendingRestartState, t],
  )

  const checkOne = useCallback(async (kind: PermissionKind): Promise<PermissionDescriptor | null> => {
    const ipc = getIpc()
    if (!ipc?.check) return null
    try {
      const next = applyPendingRestartState(await ipc.check(kind))
      if (!mountedRef.current) return next
      setItems((prev) => {
        const exists = prev.some((it) => it.kind === kind)
        if (exists) {
          return prev.map((it) => (it.kind === kind ? next : it))
        }
        return [...prev, next]
      })
      return next
    } catch (err) {
      console.warn(`[usePermissionsState] check(${kind}) 失败:`, err)
      return null
    }
  }, [applyPendingRestartState])

  const stopPermissionPolling = useCallback((kind: PermissionKind, token?: number) => {
    const state = pollingTimersRef.current.get(kind)
    if (state && (token === undefined || state.token === token)) {
      clearInterval(state.timer)
      pollingTimersRef.current.delete(kind)
    }
  }, [])

  const startPermissionPolling = useCallback((kind: PermissionKind) => {
    // 离页后禁止再挂新 interval（openSettings/request 的 await 尾迹）
    if (!mountedRef.current) return
    stopPermissionPolling(kind)
    const token = pollingTokenRef.current + 1
    pollingTokenRef.current = token
    const timer = setInterval(() => {
      void tick()
    }, 1000)
    pollingTimersRef.current.set(kind, {
      token,
      attempts: 0,
      running: false,
      timer,
    })

    const tick = async () => {
      const state = pollingTimersRef.current.get(kind)
      if (!state || state.token !== token || state.running) return
      if (!mountedRef.current) {
        stopPermissionPolling(kind, token)
        return
      }
      if (checkingKindsRef.current.has(kind)) return
      state.running = true
      state.attempts += 1
      checkingKindsRef.current.add(kind)
      try {
        const next = await checkOne(kind)
        const latest = pollingTimersRef.current.get(kind)
        if (!latest || latest.token !== token) return
        latest.running = false
        if (!mountedRef.current || next?.status === 'granted' || latest.attempts >= 30) {
          stopPermissionPolling(kind, token)
        }
      } finally {
        checkingKindsRef.current.delete(kind)
      }
    }
    void tick()
  }, [checkOne, stopPermissionPolling])

  const request = useCallback(
    async (kind: PermissionKind) => {
      const ipc = getIpc()
      if (!ipc?.request) return
      try {
        await ipc.request(kind)
        if (!mountedRef.current) return
        markPendingRestartIfNeeded(kind)
        const next = await checkOne(kind)
        if (!mountedRef.current) return
        if (next?.status !== 'granted') {
          startPermissionPolling(kind)
        }
      } catch (err) {
        console.warn(`[usePermissionsState] request(${kind}) 失败:`, err)
      }
    },
    [checkOne, markPendingRestartIfNeeded, startPermissionPolling],
  )

  const openSettings = useCallback(
    async (kind: PermissionKind) => {
      const ipc = getIpc()
      if (!ipc?.openSettings) return
      try {
        const opened = await ipc.openSettings(kind)
        if (!mountedRef.current) return
        if (opened) {
          markPendingRestartIfNeeded(kind)
          const current = itemsRef.current.find((item) => item.kind === kind)
          if (canPollPermissionStatus(current)) {
            startPermissionPolling(kind)
          }
        }
      } catch (err) {
        console.warn(`[usePermissionsState] openSettings(${kind}) 失败:`, err)
      }
    },
    [markPendingRestartIfNeeded, startPermissionPolling],
  )

  useEffect(() => {
    void refresh({ silent: true })
  }, [refresh])

  // 页级静默轮询：并排改系统「通知」开关时无需点回窗口也能跟上。
  // 仅本 hook 挂载期间有效；离开「系统权限」section → 卸载 → clearInterval。
  useEffect(() => {
    const timer = setInterval(() => {
      if (!mountedRef.current) return
      // 窗口最小化/完全不可见时不空转；并排改系统设置时 TabTin 仍可见，会继续刷
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void refresh({ silent: true })
    }, PERMISSIONS_PAGE_POLL_INTERVAL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    const onFocus = () => {
      // 用户从系统设置切回来时静默刷新，不弹 toast
      void refresh({ silent: true })
    }
    const onVisibility = () => {
      // Electron 从系统设置返回时，有时只触发 visibilitychange 而不稳定触发 window focus。
      // 仅「曾 hidden → visible」才刷，避免同页无关 visibility 抖动空刷。
      if (document.visibilityState === 'hidden') {
        wasHiddenRef.current = true
        return
      }
      if (document.visibilityState === 'visible' && wasHiddenRef.current) {
        wasHiddenRef.current = false
        void refresh({ silent: true })
      }
    }
    // 设置页级全局刷新：从系统设置返回时同步 OS 权限，不绑定 Space 前台语义。
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- App 设置面板，非 Space 作用域
    window.addEventListener('focus', onFocus)
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 同上；Electron 有时只触发 visibilitychange
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      // 离页：先钉死 mounted，再废掉单项轮询 generation，最后清定时器
      mountedRef.current = false
      pollingTokenRef.current += 1
      for (const state of pollingTimersRef.current.values()) {
        clearInterval(state.timer)
      }
      pollingTimersRef.current.clear()
      checkingKindsRef.current.clear()
    }
  }, [])

  const platform = items[0]?.platform ?? null

  return {
    items,
    loadState,
    isRefreshing,
    errorMessage,
    platform,
    refresh,
    checkOne,
    request,
    openSettings,
  }
}
