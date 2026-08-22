import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useCrawlTabStore, type CrawlspaceViewInfo } from '@stores/useCrawlTabStore'
import { useCrawlspaceRegistry } from '@/crawlspace/registry'
import { contextRegistry, type ContextItem } from '@components/context-space/registry'
import type { CanvasPane } from '@stores/useCanvasLayoutStore'
import { useFolderContextStore, type SpaceFolderState } from '@components/context-space/folder'
import { useTerminalSessionStore, type TerminalSession } from '@components/context-space/sources/terminal'
import { useIsRemoteViewer } from '@components/context-space/hooks/useIsRemoteViewer'
import { RemoteAgentBanner } from '@components/context-space/folder/RemoteAgentBanner'
import { EXECUTION_DEVICE_APP_IDS, EXECUTION_DEVICE_APP_LABEL_FALLBACK } from '@components/context-space/executionDeviceApps'

interface CanvasPaneContentProps {
  pane: CanvasPane
  spaceId: string
  isActive: boolean
  isGroupActive?: boolean
  crawlspaceId?: string | null
  onPaneInteraction?: () => void
}

type PaneContent = CanvasPane['content']

const EMPTY_VIEW_LIST: CrawlspaceViewInfo[] = []

interface PaneFieldsDeps {
  viewInfo?: CrawlspaceViewInfo | null
  folderState?: SpaceFolderState | null
  terminalSession?: TerminalSession | null
}

function resolvePaneTitle(type: string, deps: PaneFieldsDeps): string | undefined {
  switch (type) {
    case 'tabweb': return deps.viewInfo?.title || deps.viewInfo?.url
    case 'tabfolder':  return deps.folderState?.title
    case 'terminal':   return deps.terminalSession?.title
    default:           return undefined
  }
}

function resolvePaneMeta(type: string, deps: PaneFieldsDeps): Record<string, unknown> | undefined {
  switch (type) {
    case 'tabweb':
      return deps.viewInfo?.url ? { url: deps.viewInfo.url } : undefined
    case 'tabfolder':
      return deps.folderState
        ? { path: deps.folderState.rootPath, kind: deps.folderState.kind, updatedAt: deps.folderState.updatedAt }
        : undefined
    case 'terminal':
      return deps.terminalSession
        ? { createdAt: deps.terminalSession.createdAt, source: deps.terminalSession.source, status: deps.terminalSession.status }
        : undefined
    default:
      return undefined
  }
}

const CanvasPaneContentInner: React.FC<CanvasPaneContentProps> = ({
  pane,
  spaceId,
  isActive,
  isGroupActive = true,
  crawlspaceId,
  onPaneInteraction,
}) => {
  const content = pane.content
  const viewList = useCrawlTabStore(state =>
    crawlspaceId ? state.crawlspaceContextCache[crawlspaceId]?.viewList || EMPTY_VIEW_LIST : EMPTY_VIEW_LIST
  )
  const { getConfig } = useCrawlspaceRegistry()
  const crawlspaceConfig = crawlspaceId ? getConfig(crawlspaceId) : undefined
  const { t } = useTranslation('context')
  const { isRemoteViewer, controlDeviceName, workingDir: remoteWorkingDir } = useIsRemoteViewer(spaceId)

  // parsed 须在所有 hook 之前求值（且任何分支都要求值），以保证 hook 调用顺序稳定
  const parsed = content ? contextRegistry.parseTabKey(content.tabKey) : null

  const viewInfo = useMemo(() => {
    if (!content || !parsed || parsed.type !== 'tabweb') return null
    return viewList.find(view => view.viewId === parsed.id) || null
  }, [content, parsed, viewList])

  const folderState = useFolderContextStore(state => {
    if (!parsed || parsed.type !== 'tabfolder') return null
    return state.folders[parsed.id] ?? state.userFolders[parsed.id] ?? null
  })

  const terminalSession = useTerminalSessionStore(state => {
    if (!parsed || parsed.type !== 'terminal') return null
    const sessionId = parsed.id
    const allSessions = Object.values(state.sessionsBySpace)
    for (const sessions of allSessions) {
      const found = sessions.find(session => session.id === sessionId)
      if (found) return found
    }
    return null
  })

  // 所有 hooks 调用之后再做早期 return，保持原渲染优先级
  if (!content) return null
  if (!parsed) return null

  const handler = contextRegistry.getHandler(parsed.type)
  if (!handler?.renderPane) return null

  // 遥控器视角：分屏（split view）是执行设备型 App 的另一条渲染收口（单 tab 走
  // SpaceContextArea 的 Gate1/2/3）。在此一处补 gate,避免分屏里 terminal/tabweb/
  // tabphone/tabcode/tabfolder 绕过占位、渲染需本机执行环境的真实内容。
  if (isRemoteViewer && EXECUTION_DEVICE_APP_IDS.has(parsed.type)) {
    return (
      <RemoteAgentBanner
        controlDeviceName={controlDeviceName}
        workingDir={remoteWorkingDir ?? undefined}
        appLabel={t(`remoteApp.${parsed.type}`, { defaultValue: EXECUTION_DEVICE_APP_LABEL_FALLBACK[parsed.type] })}
      />
    )
  }

  const deps: PaneFieldsDeps = { viewInfo, folderState, terminalSession }
  const title = resolvePaneTitle(parsed.type, deps)
  const meta = resolvePaneMeta(parsed.type, deps)

  const item: ContextItem = {
    type: parsed.type,
    id: parsed.id,
    tabKey: content.tabKey,
    title,
    meta
  }
  return handler.renderPane(item, {
    spaceId,
    crawlspaceId,
    crawlspaceConfig,
    isGroupActive,
    isPaneActive: isActive,
    isVisible: isGroupActive,
    viewInfo,
    onPaneInteraction,
  })
}

const isSamePaneContent = (prev: PaneContent | null, next: PaneContent | null) => {
  if (prev === next) return true
  if (!prev || !next) return false
  return prev.tabKey === next.tabKey
}

export const CanvasPaneContent = React.memo(CanvasPaneContentInner, (prev, next) => {
  // 只有这些关键属性变化时才重新渲染
  if (prev.pane.id !== next.pane.id) return false
  if (!isSamePaneContent(prev.pane.content, next.pane.content)) return false

  // 对于表格类型，只要 content 没变就不需要重新渲染
  const prevType = prev.pane.content
    ? contextRegistry.parseTabKey(prev.pane.content.tabKey)?.type
    : null
  const nextType = next.pane.content
    ? contextRegistry.parseTabKey(next.pane.content.tabKey)?.type
    : null
  if (prevType === 'tabdata' && nextType === 'tabdata') {
    // 表格 pane 不需要关心 isActive 和 crawlspaceId 的变化
    return true
  }

  if (prev.isActive !== next.isActive) return false
  if (prev.isGroupActive !== next.isGroupActive) return false
  if (prev.crawlspaceId !== next.crawlspaceId) return false

  return true
})
