import React, { Suspense } from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { Code } from 'lucide-react'
import type { ContextTypeHandler } from '../types'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { useTabCodeStore } from '@components/tabcode/hooks/useTabCodeStore'
import { PaneLoadingSkeleton } from '@components/common/ListSkeletons'
import { metaStr } from '../homeSections/metaFieldUtils'

const loadTabCodePaneHost = () => import('../../../tabcode/TabCodePaneHost')
const LazyTabCodePaneHost = React.lazy(loadTabCodePaneHost)

/**
 * TabCode handler — 每个代码项目一个独立标签
 *
 * tabKey 格式: `tabcode:{base64(path)}`
 * item.meta.path = 本地项目路径（由 openCodeProject 写入持久化 store）
 */
export const tabcodeHandler: ContextTypeHandler = {
  type: 'tabcode',
  appId: 'tabcode',
  prefetch: loadTabCodePaneHost,
  persistOnly: true,
  /**
   * keepAlive=true：避免切换 tab 时 Monaco 编辑器卸载重建，保留光标位置 / 选区 / undo 栈 /
   * git 上下文等编辑器内部状态。
   * 注意：tabcode 不加 requireResourceMembership — id 是本地 path 而不是后端资源 id，
   *      没有 ContextItem 记录可以校验。
   */
  keepAlive: true,
  // 与 tabfolder 一致：Activity hidden 会打断侧栏意图 effect / fs watch；
  // visibility 模式仅 CSS 隐藏，保证「提交或推送」在后台 keep-alive 实例上也能落地。
  keepAliveSuspendMode: 'visibility',
  appEntryMode: 'resources',
  displayLabel: 'Code',
  displayEmoji: '💻',
  agent: {
    displayName: '代码',
    capability: '本地代码项目编辑（Monaco + LSP + git），支持文件树/搜索/diff，适合软件开发协作',
    aliases: ['code', 'IDE', '代码项目'],
  },
  backendAliases: ['code'],
  searchable: true,
  searchLabelKey: 'organization:search.code',
  appMeta: {
    idField: '',
    resolve: (item) => {
      const codePath = typeof item.meta?.path === 'string' ? item.meta.path : null
      if (!codePath) return null
      const gitCtx = useTabCodeStore.getState().gitContextByPath[codePath]
      return {
        current_code_project_path: codePath,
        ...(gitCtx?.branch ? { current_git_branch: gitCtx.branch } : {}),
        ...(gitCtx?.changedFiles?.length ? { current_git_changed_files: gitCtx.changedFiles.join(', ') } : {}),
        ...(gitCtx?.selectedFile ? { current_code_file: gitCtx.selectedFile } : {}),
      }
    },
  },
  attachToChat: {
    refType: 'code_file',
    buildRef: (item) => {
      const codePath = typeof item.meta?.path === 'string' ? item.meta.path : ''
      if (!codePath) return null
      const gitCtx = useTabCodeStore.getState().gitContextByPath[codePath]
      const selectedFile = gitCtx?.selectedFile
      const filePath = selectedFile || codePath
      const label = item.title
        || codePath.split('/').filter(Boolean).pop()
        || 'TabCode'
      return {
        resourceId: filePath,
        label,
        meta: {
          filePath,
          rootPath: codePath,
        },
      }
    },
  },
  onSelect: (item, ctx) => {
    useSpaceContextTabsStore.getState().openResourceTab(ctx.tabScopeKey ?? resolveForegroundTabScopeKey(ctx.spaceId), {
      type: 'tabcode',
      id: item.id,
      title: item.title,
      meta: item.meta,
    })
  },
  resolveTabItem: (id, ctx) => {
    const codePath = metaStr(ctx.persistedItem?.meta, 'path')
    const codeTitle = ctx.persistedItem?.title || codePath?.split('/').filter(Boolean).pop() || 'TabCode'
    return {
      type: 'tabcode',
      id,
      tabKey: ctx.tabKey,
      title: codeTitle,
      meta: { path: codePath, spaceId: ctx.spaceId },
    }
  },
  getTabLabel: (item) => {
    if (item.title && item.title !== item.id) return item.title
    const path = metaStr(item.meta, 'path')
    if (path) return path.split('/').filter(Boolean).pop() || 'TabCode'
    return 'TabCode'
  },
  getTabIcon: () => <TabTypeEmoji appIdOrType="tabcode" />,
  getDragPayload: item => ({
    type: item.type,
    id: item.id,
    title: item.title,
  }),
  buildCanvasContent: item => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: tabKey => ({ tabKey }),
  renderPane: (item, ctx) => {
    const meta = item.meta || {}
    let rootPath = metaStr(meta, 'path') || null

    // 若 item.meta 没有 path，从持久化 store 读取（冷启动 fallback）
    if (!rootPath) {
      const spaceIds = Object.keys(useSpaceContextTabsStore.getState().itemsBySpace || {})
      for (const pid of spaceIds) {
        const stored = useSpaceContextTabsStore.getState().itemsBySpace[pid]?.[item.tabKey]
        if (stored?.meta?.path) {
          rootPath = metaStr(stored.meta, 'path') ?? ''
          break
        }
      }
    }

    const spaceId = metaStr(meta, 'spaceId')
    const initialSidebarTab =
      meta.initialSidebarTab === 'git'
      || meta.initialSidebarTab === 'files'
      || meta.initialSidebarTab === 'search'
        ? meta.initialSidebarTab
        : undefined

    return (
      <Suspense
        fallback={<PaneLoadingSkeleton />}
      >
        <LazyTabCodePaneHost
          rootPath={rootPath}
          spaceId={spaceId ?? null}
          tabScopeKey={ctx?.tabScopeKey ?? undefined}
          contextTabKey={item.tabKey}
          resourceId={item.id}
          initialSidebarTab={initialSidebarTab}
          assumeGitRepo={initialSidebarTab === 'git'}
          isPaneActive={ctx?.isPaneActive !== false}
        />
      </Suspense>
    )
  },
}
