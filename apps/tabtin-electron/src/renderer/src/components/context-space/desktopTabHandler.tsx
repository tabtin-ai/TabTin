import React, { Suspense } from 'react'
import { Monitor } from 'lucide-react'
import type {
  ContextItem,
  ContextRegistry,
  ContextTabKey,
  ContextTypeHandler,
} from '@components/context-space/registry'

const LazyDesktopHomePane = React.lazy(() =>
  import('@components/context-space/DesktopHomePane').then(m => ({ default: m.DesktopHomePane })),
)

export const DESKTOP_TAB_TYPE = 'desktop_home'
export const DESKTOP_TAB_VIRTUAL_ID = 'current'
export const DESKTOP_TAB_KEY = `${DESKTOP_TAB_TYPE}:${DESKTOP_TAB_VIRTUAL_ID}` as const

const TAB_LABEL = '桌面'

const PaneFallback: React.FC = () => (
  <div className="flex h-full w-full items-center justify-center text-body text-muted-foreground/60">
    加载中…
  </div>
)

const DesktopTabPane: React.FC = () => {
  return (
    <Suspense fallback={<PaneFallback />}>
      <LazyDesktopHomePane />
    </Suspense>
  )
}

export const desktopTabHandler: ContextTypeHandler = {
  type: DESKTOP_TAB_TYPE,
  renderMode: 'pane',
  keepAlive: true,
  keepAliveEvictionImmune: true,
  closable: false,
  persistOnly: true,
  displayLabel: TAB_LABEL,

  getTabLabel: () => TAB_LABEL,
  getTabIcon: () => (
    <Monitor className="h-4 w-4 shrink-0 text-muted-foreground/80" />
  ),
  getDragPayload: () => null,

  renderPane: (_item, ctx) => {
    const spaceId = ctx.spaceId
    if (!spaceId) {
      return (
        <div className="flex h-full w-full items-center justify-center text-body text-muted-foreground/60">
          未选中 Agent
        </div>
      )
    }
    return <DesktopTabPane />
  },
}

export function buildDesktopTabItem(): ContextItem {
  return {
    type: DESKTOP_TAB_TYPE,
    id: DESKTOP_TAB_VIRTUAL_ID,
    tabKey: DESKTOP_TAB_KEY as ContextTabKey,
    title: TAB_LABEL,
  }
}

export function registerDesktopTabHandler(registry: ContextRegistry): void {
  if (registry.getHandler(DESKTOP_TAB_TYPE)) return
  registry.register(desktopTabHandler)
}
