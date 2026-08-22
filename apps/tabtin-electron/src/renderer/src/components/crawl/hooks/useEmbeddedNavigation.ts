import { type RefObject } from 'react'
import type { TFunction } from 'i18next'
import type { CrawlspaceHost } from '@tabtin/crawlspace-core'
import { getElementViewBounds } from '@/utils/crawl-view-bounds'
import { reportCrawlViewError } from '../../../crawlspace/utils/reportCrawlViewError'
import { createIPCErrorHandler } from '../utils/ipc-error-handler'
import type { CrawlViewRuntimeOptions } from './useWorkspaceContext'

type HostView = CrawlspaceHost['view']
type UpdateViewBounds = (force?: boolean) => void

const handleError = createIPCErrorHandler('EmbeddedCrawlView')

interface NavigationStateSetter {
  setAddressBarStatus: (s: 'idle' | 'loading' | 'error') => void
  setAddressBarMessage: (msg: string | null) => void
  setToolbarMessage: (msg: string | null) => void
  navigationState: { isLoading: boolean }
}

interface UseEmbeddedNavigationOptions {
  tabId: string
  tabUrl: string
  hostView: HostView
  containerRef: RefObject<HTMLDivElement | null>
  updateViewBoundsRef: RefObject<UpdateViewBounds | null>
  overlayCount: number
  t: TFunction
  resolveWorkspaceContext: () => {
    crawlspaceId: string | null
    profile: string | undefined
    partition: string | undefined
    runId: string | undefined
  }
  buildViewOptions: (
    crawlspaceId: string | null,
    profile: string | undefined,
    partition: string | undefined
  ) => CrawlViewRuntimeOptions | null
  updateLocation: (updates: { url?: string; title?: string; themeColor?: string | null }) => void
  stateSetter: NavigationStateSetter
}

export function createNavigationActions({
  tabId,
  tabUrl,
  hostView,
  containerRef,
  updateViewBoundsRef,
  overlayCount,
  t,
  resolveWorkspaceContext,
  buildViewOptions,
  updateLocation,
  stateSetter,
}: UseEmbeddedNavigationOptions) {
  const { setAddressBarStatus, setAddressBarMessage, setToolbarMessage, navigationState } = stateSetter

  const forceSyncViewBoundsBurst = () => {
    updateViewBoundsRef.current?.(true)
    requestAnimationFrame(() => {
      updateViewBoundsRef.current?.(true)
      setTimeout(() => updateViewBoundsRef.current?.(true), 50)
      setTimeout(() => updateViewBoundsRef.current?.(true), 150)
      setTimeout(() => updateViewBoundsRef.current?.(true), 300)
    })
  }

  const runNavigationAction = async (
    fallbackMessage: string,
    action: () => Promise<{ success: boolean; error?: string }>,
    markLoading = false
  ) => {
    if (markLoading) setAddressBarStatus('loading')
    try {
      const result = await action()
      if (!result?.success) {
        const message = result?.error || fallbackMessage
        setToolbarMessage(message)
        setAddressBarStatus('error')
        setAddressBarMessage(message)
        return result
      }
      if (!navigationState.isLoading) {
        setAddressBarStatus('idle')
        setAddressBarMessage(null)
      }
      setToolbarMessage(null)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : fallbackMessage
      handleError(fallbackMessage)(error)
      setToolbarMessage(message)
      setAddressBarStatus('error')
      setAddressBarMessage(message)
      return { success: false, error: message }
    }
  }

  const handleNavigate = async (newUrl: string) => {
    // 乐观更新 + 回滚：地址栏先展示目标 URL（对齐浏览器直觉），但导航
    // 失败或被主进程跳过（task-lock）时必须回退——否则地址栏和页面脱钩
    // （地址栏是搜索结果 URL、页面还停在旧站， 现场）。
    const previousUrl = tabUrl
    const revertLocation = () => {
      if (previousUrl && previousUrl !== newUrl) {
        updateLocation({ url: previousUrl })
      }
    }
    updateLocation({ url: newUrl, themeColor: null })
    setAddressBarStatus('loading')
    setAddressBarMessage(null)
    setToolbarMessage(null)

    const bounds = containerRef.current && overlayCount <= 0
      ? getElementViewBounds(containerRef.current)
      : null
    if (!bounds) {
      // 容器未挂载 / overlay 占用：不发起导航。保留乐观 URL 不回滚——
      // overlay 关闭后 display effect 会按 tab.url 补导航（既有延迟导航语义）
      return
    }
    try {
      const { crawlspaceId: resolvedCrawlspaceId, profile, partition, runId } = resolveWorkspaceContext()
      const kind = resolvedCrawlspaceId ? 'workspace-view' : 'normal-view'
      const viewOptions = buildViewOptions(resolvedCrawlspaceId, profile, partition)
      if (!viewOptions) {
        throw reportCrawlViewError({
          action: 'crawlView.show', message: t('embedded.errors.missingProfile'),
          viewId: tabId, crawlspaceId: resolvedCrawlspaceId || undefined, profile, partition, kind
        })
      }
      if (!hostView?.show) throw new Error(t('embedded.errors.showUnavailable'))
      const response = await hostView.show(tabId, newUrl, bounds, runId, viewOptions)
      if (!response?.success) {
        const message = response?.error || t('embedded.errors.navigationFailed')
        revertLocation()
        setAddressBarStatus('error')
        setAddressBarMessage(message)
        setToolbarMessage(message)
      } else if (response.skipped === 'task-lock') {
        // Agent 任务占用中，主进程跳过了导航：页面没动，地址栏回退并说明
        revertLocation()
        setAddressBarStatus('idle')
        setToolbarMessage(t('embedded.errors.navigationDeferredByAgent'))
      } else {
        setAddressBarStatus('idle')
        forceSyncViewBoundsBurst()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('embedded.errors.navigationFailed')
      revertLocation()
      setAddressBarStatus('error')
      setAddressBarMessage(message)
      setToolbarMessage(message)
    }
  }

  const handleGoBack = async () => {
    await runNavigationAction(
      t('embedded.errors.goBackFailed'),
      () => hostView?.goBack?.(tabId) || Promise.resolve({ success: false, error: t('embedded.errors.actionUnavailable', { action: 'goBack' }) }),
      true
    )
  }

  const handleGoForward = async () => {
    await runNavigationAction(
      t('embedded.errors.goForwardFailed'),
      () => hostView?.goForward?.(tabId) || Promise.resolve({ success: false, error: t('embedded.errors.actionUnavailable', { action: 'goForward' }) }),
      true
    )
  }

  const handleReload = async () => {
    await runNavigationAction(
      t('embedded.errors.reloadFailed'),
      async () => {
        if (!hostView?.reload) return { success: false, error: 'hostView.reload is missing' }
        const result = await hostView.reload(tabId, true)
        setTimeout(() => { updateViewBoundsRef.current?.() }, 100)
        return result || { success: false, error: t('embedded.errors.actionUnavailable', { action: 'reload' }) }
      },
      true
    )
  }

  const handleStop = async () => {
    await runNavigationAction(
      t('embedded.errors.stopFailed'),
      () => hostView?.stop?.(tabId) || Promise.resolve({ success: false, error: t('embedded.errors.actionUnavailable', { action: 'stop' }) })
    )
  }

  return { handleNavigate, handleGoBack, handleGoForward, handleReload, handleStop }
}
