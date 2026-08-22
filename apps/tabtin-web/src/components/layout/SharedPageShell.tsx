import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { FileText, Home, PanelLeft, Table2, X } from 'lucide-react'
import { Sheet, SheetContent, SheetTitle } from '@tabtin/smartsheet-ui'
import { useAuthStore } from '@/stores/auth-store'
import {
  useOrganizationStore,
  useSpaceStore,
} from '@tabtin/app-shell'
import { spaceHomePath } from '@/features/space/spaceRoutes'
import { cn } from '@/utils/cn'
import {
  ShareNavigationProvider,
  useShareNavigation,
} from './ShareNavigationContext'

const WebSidebar = lazy(() =>
  import('@/components/sidebar/WebSidebar').then((module) => ({ default: module.WebSidebar })),
)

/**
 * SharedPageShell — 公开分享页（文档/表格）的外壳
 *
 * 分享链接本身是公开可访问的：匿名访客保持原有的纯净分享页（无侧边栏），
 * 避免把登录用户的私有空间导航暴露给陌生人。
 * 当访客已登录时，则把分享内容嵌进与首页一致的左侧侧边栏外壳里，
 * 并在内容区顶部展示当前分享资源的页签（对齐自有 TabDoc 打开时的页签感），
 * 让从 Electron 分享出来的链接在 web 端打开时也能直接回到自己的工作区导航。
 */
export function SharedPageShell({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const { pathname } = useLocation()

  const openMobileSidebar = () => setMobileSidebarOpen(true)

  useEffect(() => {
    setMobileSidebarOpen(false)
  }, [pathname])

  if (!isAuthenticated) {
    return (
      <>
        {children}
        <SharedPageExitButton fallbackPath="/" floating />
      </>
    )
  }

  return (
    <ShareNavigationProvider>
      <div className="h-screen flex overflow-hidden" style={{ background: 'hsl(var(--canvas))' }}>
        <aside className="hidden flex-shrink-0 md:block">
          <Suspense fallback={<div className="flex-shrink-0" style={{ width: 240 }} />}>
            <WebSidebar />
          </Suspense>
        </aside>
        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetContent
            side="left"
            className="w-[min(84vw,280px)] max-w-[280px] overflow-hidden p-0 md:hidden"
          >
            <SheetTitle className="sr-only">工作区导航</SheetTitle>
            <div className="h-full">
              <Suspense fallback={<div className="h-full w-full bg-background" />}>
                <WebSidebar />
              </Suspense>
            </div>
          </SheetContent>
        </Sheet>
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <SharedResourceTabBar onOpenSidebar={openMobileSidebar} />
          <main className="flex-1 overflow-y-auto min-w-0">{children}</main>
        </div>
      </div>
    </ShareNavigationProvider>
  )
}

function SharedResourceTabBar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const navigate = useNavigate()
  const { activeShare } = useShareNavigation()
  const selectedSpace = useSpaceStore((s) => s.selectedSpace)
  const selectedOrganization = useOrganizationStore((s) => s.selectedOrganization)

  const homePath = useMemo(
    () => spaceHomePath(selectedOrganization?.id ?? null, selectedSpace?.id ?? null),
    [selectedOrganization?.id, selectedSpace?.id],
  )

  const Icon = activeShare?.kind === 'table' ? Table2 : FileText
  const pathLabel = (activeShare?.locationPath ?? [])
    .map((node) => node.title?.trim() || '未命名')
    .join(' / ')

  return (
    <div className="flex-shrink-0 border-b border-border/40 bg-background/90 px-2">
      <div className="flex items-center gap-1 h-9 min-w-0">
        <button
          type="button"
          onClick={onOpenSidebar}
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] md:hidden',
            'text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground',
          )}
          title="打开工作区导航"
          aria-label="打开工作区导航"
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => navigate(homePath)}
          className={cn(
            'shrink-0 h-7 w-7 rounded-[4px] flex items-center justify-center',
            'text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors',
          )}
          title="工作区首页"
          aria-label="工作区首页"
        >
          <Home className="h-3.5 w-3.5" />
        </button>

        {activeShare ? (
          <div
            className={cn(
              'group relative flex items-center gap-1 h-7 py-1 px-2 rounded-[4px] text-caption',
              'min-w-[48px] max-w-[220px] shrink-0 overflow-hidden border box-border',
              'bg-accent/15 text-foreground border-accent/25',
            )}
            title={activeShare.title}
          >
            {activeShare.icon ? (
              <span className="shrink-0 text-caption leading-none">{activeShare.icon}</span>
            ) : (
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="flex-1 truncate">{activeShare.title || '未命名文档'}</span>
          </div>
        ) : null}

        {pathLabel ? (
          <div
            className="ml-2 min-w-0 flex-1 truncate text-caption text-muted-foreground"
            title={pathLabel}
          >
            {pathLabel}
          </div>
        ) : (
          <div className="min-w-0 flex-1" />
        )}

        <SharedPageExitButton fallbackPath={homePath} />
      </div>
    </div>
  )
}

function SharedPageExitButton({
  fallbackPath,
  floating = false,
}: {
  fallbackPath: string
  floating?: boolean
}) {
  const navigate = useNavigate()

  const exitSharePage = () => {
    const desktopHomeUrl = (window as typeof window & {
      electron?: { process?: { env?: { ELECTRON_RENDERER_URL?: string } } }
    }).electron?.process?.env?.ELECTRON_RENDERER_URL

    if (desktopHomeUrl) {
      window.location.assign(desktopHomeUrl)
      return
    }
    if (window.history.length > 1) {
      navigate(-1)
      return
    }
    navigate(fallbackPath, { replace: true })
  }

  return (
    <button
      type="button"
      onClick={exitSharePage}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/60',
        'bg-background/90 px-2.5 text-caption text-muted-foreground shadow-sm backdrop-blur-sm',
        'transition-colors hover:bg-muted hover:text-foreground',
        floating && 'fixed right-4 top-4 z-50',
      )}
      title="退出分享页"
      aria-label="退出分享页"
    >
      <X className="h-3.5 w-3.5" />
      <span>退出</span>
    </button>
  )
}
