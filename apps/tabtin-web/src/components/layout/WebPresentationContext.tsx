import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useLocation } from 'react-router-dom'
import { useUIStore } from '../../stores/ui-store'
import {
  getServerWebPresentationEnvironmentSnapshot,
  getWebPresentationEnvironmentSnapshot,
  subscribeWebPresentationEnvironment,
  type WebPresentationEnvironment,
} from './WebPresentationEnvironment'
import {
  parseWebPresentation,
  type WebRoutePresentation,
} from './WebRoutePresentation'

export {
  parseWebPresentation,
  type WebClient,
  type WebHostTheme,
  type WebShell,
} from './WebRoutePresentation'

export interface WebPresentation extends WebRoutePresentation, WebPresentationEnvironment {}

const DEFAULT_ROUTE_PRESENTATION: WebRoutePresentation = {
  shell: 'full',
  client: 'browser',
  isEmbedded: false,
  hostTheme: null,
}

const DEFAULT_PRESENTATION: WebPresentation = {
  ...DEFAULT_ROUTE_PRESENTATION,
  ...getServerWebPresentationEnvironmentSnapshot(),
}

const WebPresentationContext = createContext<WebPresentation>(DEFAULT_PRESENTATION)

export function WebPresentationProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  // 宿主模式由 WebView 首次加载地址决定，并在同一次 SPA 导航期间保持稳定。
  // 资源内链接即使没有重复拼 query，也不会突然恢复桌面侧栏。
  const initialPresentation = useRef<WebRoutePresentation | null>(null)
  if (initialPresentation.current === null) {
    initialPresentation.current = parseWebPresentation(location.search)
  }
  const environment = useSyncExternalStore(
    subscribeWebPresentationEnvironment,
    getWebPresentationEnvironmentSnapshot,
    getServerWebPresentationEnvironmentSnapshot,
  )
  const value = useMemo<WebPresentation>(
    () => ({
      ...(initialPresentation.current ?? DEFAULT_ROUTE_PRESENTATION),
      ...environment,
    }),
    [environment],
  )

  useEffect(() => {
    if (!value.hostTheme) return

    document.documentElement.classList.toggle('dark', value.hostTheme === 'dark')
    useUIStore.setState({ resolvedTheme: value.hostTheme })
  }, [value.hostTheme])

  return <WebPresentationContext.Provider value={value}>{children}</WebPresentationContext.Provider>
}

export function useWebPresentation(): WebPresentation {
  return useContext(WebPresentationContext)
}
