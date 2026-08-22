/**
 * ShareNavigationContext — 登录态分享页的「当前打开资源」导航态
 *
 * SharedPageShell 已把分享内容嵌进左侧工作区导航；自有 TabDoc 靠 URL 里的
 * documentId 让侧栏高亮、顶部呈现当前文档。分享路由只有 shareId，需要本
 * Context 把已解析的文档标题 / 路径 / documentId 广播给：
 *  - SharedPageShell 顶部页签条
 *  - SpaceResourceTree 高亮与「当前分享」伪条目
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export interface ShareLocationNode {
  id: string
  title: string
  icon?: string
}

export interface ShareNavigationState {
  kind: 'doc' | 'table'
  shareId: string
  title: string
  icon?: string
  documentId?: string | null
  tableId?: string | null
  spaceId?: string | null
  organizationId?: string | null
  locationPath?: ShareLocationNode[]
}

interface ShareNavigationContextValue {
  activeShare: ShareNavigationState | null
  setActiveShare: (next: ShareNavigationState | null) => void
}

const ShareNavigationContext = createContext<ShareNavigationContextValue | null>(null)

export function ShareNavigationProvider({ children }: { children: ReactNode }) {
  const [activeShare, setActiveShareState] = useState<ShareNavigationState | null>(null)
  const setActiveShare = useCallback((next: ShareNavigationState | null) => {
    setActiveShareState(next)
  }, [])

  const value = useMemo(
    () => ({ activeShare, setActiveShare }),
    [activeShare, setActiveShare],
  )

  return (
    <ShareNavigationContext.Provider value={value}>
      {children}
    </ShareNavigationContext.Provider>
  )
}

export function useShareNavigation(): ShareNavigationContextValue {
  const ctx = useContext(ShareNavigationContext)
  if (!ctx) {
    return {
      activeShare: null,
      setActiveShare: () => undefined,
    }
  }
  return ctx
}
