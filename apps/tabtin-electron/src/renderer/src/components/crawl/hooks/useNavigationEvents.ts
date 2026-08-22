import { useCallback, useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { createIPCErrorHandler } from '../utils/ipc-error-handler'

const handleError = createIPCErrorHandler('NavigationEvents')

export type NavigationState = {
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  url: string
  title: string
  themeColor?: string | null
}

type HostViewLike = {
  onEvent?: (callback: (event: any) => void) => (() => void) | undefined
  getNavigationState?: (viewId: string) => Promise<{ success: boolean; state?: NavigationState }>
  reload?: (viewId: string, ignoreCache: boolean) => Promise<any>
}

export type NavigationEventsOptions = {
  tabId: string
  hostView: HostViewLike | undefined
  managedExternally: boolean
  isActive: boolean
  updateLocation: (updates: { url?: string; title?: string; themeColor?: string | null }) => void
  touchView: (reason: string) => void
  t: TFunction
}

export function useNavigationEvents({
  tabId,
  hostView,
  managedExternally,
  isActive,
  updateLocation,
  touchView,
  t,
}: NavigationEventsOptions) {
  const [navigationState, setNavigationState] = useState<NavigationState>({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    url: '',
    title: '',
    themeColor: undefined,
  })

  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  const hasLoadedOnceRef = useRef(false)
  const markLoadedOnce = useCallback(() => {
    if (hasLoadedOnceRef.current) return
    hasLoadedOnceRef.current = true
    setHasLoadedOnce(true)
  }, [])

  const [addressBarStatus, setAddressBarStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [addressBarMessage, setAddressBarMessage] = useState<string | null>(null)
  const [toolbarMessage, setToolbarMessage] = useState<string | null>(null)
  const statusRef = useRef<'idle' | 'loading' | 'error'>(addressBarStatus)

  useEffect(() => {
    statusRef.current = addressBarStatus
  }, [addressBarStatus])

  const updateNavigationState = useCallback(async () => {
    try {
      if (!hostView?.getNavigationState) return
      // contract W2-β: getNavigationState 走 IPC `crawl-view:getNavigationState`
      // (LEGACY_HANDLERS 内)，返 legacy `{success, state?}`。
      // 这里是轮询读 nav state，单次失败不重试也不报错（fail-soft，下次轮询恢复），
      // 所以保留双分支语义不转 throw；变量重命名避开字面 result.success。
      const navRes = await hostView.getNavigationState(tabId)
      if (navRes.success && navRes.state) {
        // 空导航态（url === ''）说明 WebContents 尚不存在或未附着——
        // webview 模式下新 tab 的 guest 还没创建时主进程就会返回这种空态。
        // 此时绝不能回写 store，否则会把 createView 刚写入的 URL 擦成空串，
        // show 走不下去（"url is required"），tab 永久卡在"加载中"（ B5）。
        if (navRes.state.url) {
          updateLocation({ url: navRes.state.url, title: navRes.state.title })
        }
        setNavigationState(prev => ({ ...prev, ...navRes.state! }))
        if (!navRes.state.isLoading) {
          if (statusRef.current !== 'error') {
            statusRef.current = 'idle'
            setAddressBarStatus('idle')
            setAddressBarMessage(null)
            setToolbarMessage(null)
          }
          if (navRes.state.url || navRes.state.title) {
            markLoadedOnce()
          }
        }
      }
    } catch (error) {
      handleError('getNavigationState')(error)
    }
  }, [hostView, tabId, markLoadedOnce, updateLocation])

  useEffect(() => {
    if (managedExternally) return

    const unsubscribe = hostView?.onEvent?.((event) => {
      const eventViewId = event?.data?.viewId || event?.viewId || event?.tabId
      if (eventViewId && eventViewId !== tabId) return

      if (event.type === 'title:changed') {
        const { title, url } = event.data
        updateLocation({ title, url })
        touchView('title:changed')
      }

      if (event.type === 'url:changed') {
        const { url } = event.data
        updateLocation({ url })
        touchView('url:changed')
      }

      if (event.type === 'theme-color:changed') {
        const { themeColor } = event.data
        setNavigationState(prev => ({ ...prev, themeColor }))
        updateLocation({ themeColor })
      }

      if (event.type === 'page:loading') {
        // 同步写 statusRef：主进程 fail-load 后会立刻再发 navigation:state，
        // 若只靠 useEffect 更新 ref，同轮事件会把 error 误清成 idle。
        statusRef.current = 'loading'
        setAddressBarStatus('loading')
        setNavigationState(prev => ({ ...prev, themeColor: null }))
        updateLocation({ themeColor: null })
        touchView('page:loading')
      }

      if (event.type === 'page:loaded') {
        if (statusRef.current !== 'error') {
          statusRef.current = 'idle'
          setAddressBarStatus('idle')
          setAddressBarMessage(null)
          setToolbarMessage(null)
        }
        touchView('page:loaded')
        markLoadedOnce()
        updateNavigationState()
      }

      if (event.type === 'navigation:state') {
        const state = event.data as NavigationState
        // 同 updateNavigationState：空导航态不回写 store（见上方注释）。
        if (state.url) {
          updateLocation({ url: state.url, title: state.title })
        }
        setNavigationState(prev => ({
          ...prev,
          ...state,
          themeColor: state.isLoading ? null : prev.themeColor,
        }))
        if (state.isLoading) {
          updateLocation({ themeColor: null })
        }
        if (!state.isLoading) {
          if (statusRef.current !== 'error') {
            statusRef.current = 'idle'
            setAddressBarStatus('idle')
            setAddressBarMessage(null)
            setToolbarMessage(null)
          } else {
            statusRef.current = 'error'
            setAddressBarStatus('error')
          }
          if (state.url || state.title) {
            markLoadedOnce()
          }
        } else {
          statusRef.current = 'loading'
          setAddressBarStatus('loading')
        }
        touchView('navigation:state')
      }

      if (event.type === 'page:error' || event.type === 'navigation:failed') {
        const message = event.data?.errorDescription || t('embedded.errors.pageLoadFailed')
        statusRef.current = 'error'
        setAddressBarStatus('error')
        setAddressBarMessage(message)
        setToolbarMessage(message)
        touchView('page:error')
      }
    })

    return () => { unsubscribe?.() }
  }, [managedExternally, tabId, updateLocation, touchView, t, hostView, markLoadedOnce, updateNavigationState])

  useEffect(() => {
    if (managedExternally || !isActive) return
    updateNavigationState()
  }, [isActive, managedExternally, updateNavigationState])

  useEffect(() => {
    if (!navigationState.isLoading && (navigationState.url || navigationState.title)) {
      markLoadedOnce()
    }
  }, [markLoadedOnce, navigationState.isLoading, navigationState.title, navigationState.url])

  useEffect(() => {
    if (managedExternally) return
    const ipc = window.electron?.ipcRenderer
    if (!ipc) return

    const handleReload = (_event: unknown, payload?: { ignoreCache?: boolean }) => {
      if (!isActive || !hostView?.reload) return
      hostView.reload(tabId, Boolean(payload?.ignoreCache)).catch((error: unknown) => {
        handleError('reload')(error)
        const fallbackMessage = t('embedded.errors.refreshFailed')
        const message = error instanceof Error ? error.message : fallbackMessage
        setToolbarMessage(message)
        setAddressBarStatus('error')
        setAddressBarMessage(message)
      })
    }

    const unsubReload = ipc.on('app:crawl-tab-reload', handleReload)
    return unsubReload
  }, [isActive, managedExternally, t, hostView, tabId])

  return {
    navigationState,
    setNavigationState,
    hasLoadedOnce,
    addressBarStatus,
    setAddressBarStatus,
    addressBarMessage,
    setAddressBarMessage,
    toolbarMessage,
    setToolbarMessage,
    statusRef,
  }
}
