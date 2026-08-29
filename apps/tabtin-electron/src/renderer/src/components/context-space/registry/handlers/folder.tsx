import React from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { FolderOpen, FolderPlus } from 'lucide-react'
import type { ContextTypeHandler } from '../types'
import { useFolderContextStore } from '@components/context-space/folder/useFolderStore'
import type { FolderContextKind } from '@components/context-space/folder/types'
import { useClosedTabsStore } from '@stores/useClosedTabsStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import i18n from '@/i18n'
import { metaStr } from '../homeSections/metaFieldUtils'

const FolderPaneRenderer = React.lazy(() =>
  import('./renderers/FolderPaneRenderer').then(m => ({ default: m.FolderPaneRenderer }))
)

const LocalDirAutoPane = React.lazy(() =>
  import('@components/context-space/folder/LocalDirAutoPane').then(m => ({ default: m.LocalDirAutoPane }))
)

const LazyTabFolderHomePane = React.lazy(() =>
  import('@components/context-space/folder/TabFolderHomePane').then(m => ({ default: m.TabFolderHomePane }))
)

// TabFolder 是 Desktop 级目录库：首页只列用户主动添加的目录；
// 单个 tabfolder:{id} 标签用于查看具体目录内容。
export const folderHandler: ContextTypeHandler = {
  type: 'tabfolder',
  appId: 'tabfolder',
  backendAliases: ['folder'],
  persistOnly: true,
  appEntryMode: 'resources',
  keepAlive: true,
  // ：默认 Activity hidden 会重新执行 FileTree 的初始化 effect，
  // 使用户切回本地目录时丢失已展开的目录现场。仅视觉隐藏可保留该状态；
  // 标签被现有 LRU 淘汰或关闭时，组件仍会正常释放。
  keepAliveSuspendMode: 'visibility',
  displayLabel: i18n.t('context:appName.tabfolder', { defaultValue: 'Directories' }),
  displayEmoji: '📁',
  sidebarPanel: LazyTabFolderHomePane,
  agent: {
    displayName: '目录',
    capability: '浏览本机文件系统的某个目录（user / sandbox 两种 kind），Agent 可 read / list / edit 这些文件',
    aliases: ['folder', '文件夹', '目录'],
  },
  /**
   * 关闭 folder tab：仅推入 closedTabsStore 供 ⌘⇧T 还原。
   * 契约：不得修改 tabOrder / activeKey — useCloseHandlers 统一兜底 closeTab。
   */
  onClose: (item, ctx) => {
    useClosedTabsStore.getState().push({
      type: 'tabfolder',
      id: item.id,
      tabKey: item.tabKey,
      title: item.title || i18n.t('folder.labels.defaultTitle', { ns: 'context' }),
      spaceId: ctx.spaceId,
      meta: {
        path: metaStr(item.meta, 'path') || undefined,
        kind: metaStr(item.meta, 'kind') || undefined,
      },
    })
  },
  onRefresh: (item) => {
    useFolderContextStore.getState().refreshFolder(item.id)
  },
  resolveTabItem: (id, ctx) => {
    const { folders, userFolders } = useFolderContextStore.getState()
    const folder = folders[id] ?? userFolders[id] ?? null
    const kind = folder?.kind || metaStr(ctx.persistedItem?.meta, 'kind') || 'user'
    const revealPath = metaStr(ctx.persistedItem?.meta, 'reveal_path')
    const title = kind === 'sandbox'
      ? i18n.t('folder.labels.agentTitle', { ns: 'context' })
      : folder?.title || ctx.persistedItem?.title || i18n.t('folder.labels.defaultTitle', { ns: 'context' })
    return {
      type: 'tabfolder',
      id,
      tabKey: ctx.tabKey,
      title,
      meta: {
        path: folder?.rootPath || metaStr(ctx.persistedItem?.meta, 'path') || '',
        kind,
        ...(revealPath ? { reveal_path: revealPath } : {}),
      },
    }
  },
  appMeta: {
    idField: '',
    resolve: (item) => {
      const folderPath = metaStr(item.meta, 'path') || null
      const folderKind = metaStr(item.meta, 'kind') || 'user'
      if (!folderPath) return null
      if (folderKind === 'sandbox') {
        return { sandbox_path: folderPath, current_file_path: null }
      }
      return { current_folder_path: folderPath, current_file_path: null }
    },
  },
  attachToChat: {
    refType: 'folder',
    buildRef: (item) => {
      const folderPath = metaStr(item.meta, 'path')
      if (!folderPath) return null
      const folderKind = metaStr(item.meta, 'kind') || 'user'
      const isSandbox = folderKind === 'sandbox'
      const fallbackTitle = isSandbox
        ? i18n.t('folder.labels.agentTitle', { ns: 'context' })
        : i18n.t('folder.labels.defaultTitle', { ns: 'context' })
      return {
        resourceId: folderPath,
        label: isSandbox ? fallbackTitle : (item.title || fallbackTitle),
        meta: { kind: folderKind },
      }
    },
  },
  onSelect: (item, ctx) => {
    useSpaceContextTabsStore.getState().openResourceTab(ctx.tabScopeKey ?? resolveForegroundTabScopeKey(ctx.spaceId), {
      type: 'tabfolder',
      id: item.id,
      title: item.title,
      meta: item.meta,
    })
  },
  getTabLabel: (item) => {
    const isSandbox = item.meta?.kind === 'sandbox'
    const fallback = isSandbox
      ? i18n.t('context:folder.labels.agentTitle')
      : i18n.t('context:folder.labels.defaultTitle')
    return isSandbox ? fallback : (item.title || fallback)
  },
  getTabIcon: () => <TabTypeEmoji appIdOrType="tabfolder" />,
  getDragPayload: (item) => ({
    type: 'tabfolder',
    id: item.id,
    title: item.title,
    path: typeof item.meta?.path === 'string' ? item.meta.path : undefined
  }),
  buildCanvasContent: (item) => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: (tabKey) => ({ tabKey }),
  renderPane: (item, ctx) => {
    const rootPath = metaStr(item.meta, 'path') || ''
    const revealPath = metaStr(item.meta, 'reveal_path') || ''
    const kind = (item.meta?.kind as FolderContextKind) || 'user'
    const title = kind === 'sandbox'
      ? i18n.t('context:folder.labels.agentTitle')
      : item.title || i18n.t('context:folder.labels.defaultTitle')

    if (!rootPath) {
      return (
        <div className="h-full w-full flex flex-col items-center justify-center text-muted-foreground">
          <FolderPlus className="h-12 w-12 mb-3 opacity-30" />
          <p className="text-body">{i18n.t('context:folder.status.noOpenTitle')}</p>
          <p className="text-body mt-1 opacity-60">{i18n.t('context:folder.status.noOpenHint')}</p>
        </div>
      )
    }

    const fallback = (
      <div className="flex h-full items-center justify-center text-body text-muted-foreground">
        {i18n.t('label.loading', { ns: 'context' })}
      </div>
    )

    // 用户手动添加的目录（kind='user'）参与 Git 流程自动判定；Agent 沙箱目录
    // （kind='sandbox'）维持普通文件浏览视图，不接入 Git 流程形态。
    if (kind === 'user') {
      const preferredView = item.meta?.preferredView === 'code' || item.meta?.preferredView === 'folder'
        ? item.meta.preferredView
        : undefined
      return (
        <React.Suspense fallback={fallback}>
          <LocalDirAutoPane
            rootPath={rootPath}
            kind={kind}
            title={title}
            revealPath={revealPath || undefined}
            spaceId={ctx.spaceId}
            resourceId={item.id}
            requiresSessionAuthorization
            preferredView={preferredView}
            contextScopeKey={ctx.tabScopeKey ?? ctx.spaceId}
            contextTabKey={item.tabKey}
            isPaneActive={ctx?.isPaneActive !== false}
          />
        </React.Suspense>
      )
    }

    return (
      <React.Suspense fallback={fallback}>
        <FolderPaneRenderer
          rootPath={rootPath}
          kind={kind}
          title={title}
          revealPath={revealPath || undefined}
          contextScopeKey={ctx.tabScopeKey ?? ctx.spaceId}
          contextTabKey={item.tabKey}
        />
      </React.Suspense>
    )
  }
}
