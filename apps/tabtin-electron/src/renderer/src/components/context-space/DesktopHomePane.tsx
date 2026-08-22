/**
 * DesktopHomePane —— 桌面「主页」驾驶舱
 *
 * 从静态欢迎海报改为反映真实状态的工作起点：
 * - 开始新的：高频创建动作（文档 / 表格 / 网页 / 终端）
 * - 继续：桌面标签池里已打开的内容，一键跳回（数据来自 visibleItems，零新增存储）
 * - 常用：置顶应用磁贴（与侧栏置顶同一份数据），末尾入口去「更多应用」管理
 * 「桌面 vs 对话」科普降级为首次可关闭的提示条，不再常驻占版面。
 */
import React, { useCallback, useMemo } from 'react'
import { FileText, Globe, Loader2, Table2, Terminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@components/ui'
import { useSpaceContextActions, useSpaceContextState } from './SpaceContextAreaContext'
import { useSpaceApps } from '@stores/useSpaceApps'
import { contextRegistry } from './registry'
import {
  DESKTOP_APPS_HOME_ID,
  DESKTOP_RAIL_EXCLUDED_APP_IDS,
  useDesktopAppEntries,
  type DesktopAppEntry,
} from './desktopAppsModel'
import { activateDesktopAppEntry } from './desktopAppActivation'
import { DESKTOP_TAB_TYPE } from './desktopTabHandler'
import { CONTEXT_PAGE_HEADER_GAP, CONTEXT_PAGE_SHELL_FILL } from './constants'
import { ContextPageHeader } from './ContextPageHeader'
import { cn } from '@utils/cn'
import {
  CANVAS_TEXT_EYEBROW,
  CANVAS_TEXT_META,
  CANVAS_TEXT_SECONDARY,
} from '@components/layout/canvasUi'
import { useUnifiedResources } from '@stores/useUnifiedResources'
import { useSpaceStore } from '@stores/useSpaceStore'
import type { ContextItem } from './registry/types'
import { resolveAppIconPresentation, SidebarTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import {
  buildWorkspaceExecutionRootEntry,
  openWorkspaceExecutionRoot,
  resolveWorkspaceWorkingDir,
  resolveWorkspaceWorkingDirType,
} from './workspaceExecutionRootApp'

const EMPTY_RESOURCE_ITEMS: never[] = []

// 继续区只展示「内容」标签，排除起始页/桌面占位这类导航型伪标签。
const NON_CONTENT_TAB_TYPES = new Set<string>(['apphome', DESKTOP_TAB_TYPE])

export const DesktopHomePane: React.FC<{ variant?: 'apps' | 'task-workbench' }> = ({
  variant = 'apps',
}) => {
  const { t } = useTranslation('context')
  const { createHandlers, onOpenAppHome, onSelectItem } = useSpaceContextActions()
  const { spaceId, visibleItems, creatingAppIds, tabScopeKey } = useSpaceContextState()
  const spaces = useSpaceStore(state => state.spaces)
  const spaceRecord = useSpaceStore(state => state.spaces.find(space => space.id === spaceId) ?? null)
  const workspaceAgent = useSpaceStore(state => {
    if (spaceRecord?.type !== 'workspace') return null
    const agentId = spaceRecord.execution_agent_id ?? spaceRecord.agent_id ?? null
    if (!agentId) return null
    return state.agentCache[agentId]
      ?? (state.selectedAgent?.id === agentId ? state.selectedAgent : null)
  })
  const workingDir = resolveWorkspaceWorkingDir(spaceRecord, workspaceAgent)
  const workingDirType = resolveWorkspaceWorkingDirType(spaceRecord, workspaceAgent)
  const executionRootEntry = useMemo(
    () => buildWorkspaceExecutionRootEntry({
      spaceId,
      workingDir,
      workingDirType,
      t,
    }),
    [spaceId, t, workingDir, workingDirType],
  )

  const spaceApps = useSpaceApps(state => state.appsBySpace[spaceId])
  const appEntries = useDesktopAppEntries(t, spaceApps)
  const resourcesBySpaceId = useUnifiedResources(state => state.resourcesBySpaceId)
  const resourceItems = useMemo(() => {
    const currentOrganizationId = spaces.find(space => space.id === spaceId)?.organization_id
    const seen = new Set<string>()
    const result: Array<(typeof resourcesBySpaceId)[string][number]> = []
    for (const space of spaces) {
      if (
        space.is_archived ||
        (currentOrganizationId && space.organization_id !== currentOrganizationId)
      ) {
        continue
      }
      for (const item of resourcesBySpaceId[space.id] ?? EMPTY_RESOURCE_ITEMS) {
        const key = `${item.item_type}:${item.resource_id}`
        if (seen.has(key)) continue
        seen.add(key)
        result.push(item)
      }
    }
    return result
  }, [resourcesBySpaceId, spaceId, spaces])

  const activateApp = useCallback(
    (entry: DesktopAppEntry) => activateDesktopAppEntry(entry, { createHandlers, onOpenAppHome }),
    [createHandlers, onOpenAppHome],
  )

  const newActions = useMemo(() => ([
    { id: 'tabdoc', label: t('desktop.home.newDocument'), icon: <FileText className="h-3.5 w-3.5" />, run: () => createHandlers.tabdoc?.() },
    { id: 'tabdata', label: t('desktop.home.newTable'), icon: <Table2 className="h-3.5 w-3.5" />, run: () => createHandlers.tabdata?.() },
    // 「打开一个网页」跳到浏览器主页面板（主页 / 历史 / 书签入口），而不是直接新建一个默认首页标签。
    { id: 'tabweb', label: t('desktop.home.newWebTab'), icon: <Globe className="h-3.5 w-3.5" />, run: () => onOpenAppHome('tabweb') },
    { id: 'terminal', label: t('desktop.home.newTerminal'), icon: <Terminal className="h-3.5 w-3.5" />, run: () => createHandlers.terminal?.() },
  ]).filter(action => Boolean(createHandlers[action.id])), [createHandlers, onOpenAppHome, t])

  const recentItems = useMemo<ContextItem[]>(() => {
    const fromResources = resourceItems
      .filter(item => !NON_CONTENT_TAB_TYPES.has(item.item_type))
      .slice()
      .sort((left, right) => {
        const leftTime = Date.parse(left.last_visited_at ?? left.updated_at ?? '') || 0
        const rightTime = Date.parse(right.last_visited_at ?? right.updated_at ?? '') || 0
        return rightTime - leftTime
      })
      .map(item => ({
        tabKey: `${item.item_type}:${item.resource_id}` as ContextItem['tabKey'],
        type: item.item_type,
        id: item.resource_id,
        title: item.title,
        meta: {
          ...(item.metadata ?? {}),
          contextItemId: item.id,
          spaceId: item.space_id,
        },
      }))
    const seen = new Set(fromResources.map(item => item.tabKey))
    const openFallback = visibleItems.filter(item => (
      !NON_CONTENT_TAB_TYPES.has(item.type) && !seen.has(item.tabKey)
    ))
    return [...fromResources, ...openFallback].slice(0, 8)
  }, [resourceItems, visibleItems])

  const allAppEntries = useMemo(
    () => appEntries.filter(entry => !DESKTOP_RAIL_EXCLUDED_APP_IDS.has(entry.id)),
    [appEntries],
  )

  const openExecutionRoot = useCallback(() => {
    if (!executionRootEntry) return
    openWorkspaceExecutionRoot({
      tabScopeKey,
      spaceId,
      workingDir: executionRootEntry.workingDir,
      view: executionRootEntry.view,
    })
  }, [executionRootEntry, spaceId, tabScopeKey])

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn(CONTEXT_PAGE_SHELL_FILL, 'gap-5')}>
        <ContextPageHeader
          icon={<SidebarTypeEmoji appIdOrType="desktop_home" className="h-10 w-10" />}
          iconSurface="none"
          title={variant === 'task-workbench'
            ? t('desktop.home.taskWorkbenchTitle', { defaultValue: '打开应用工作台' })
            : t('desktop.home.appsStartTitle', { defaultValue: '从应用开始工作' })}
          titleAs="h1"
          description={variant === 'task-workbench'
            ? t('desktop.home.taskWorkbenchSubtitle', {
                defaultValue: '从已有应用或新应用进入工作现场，打开后会成为当前任务的一个标签。',
              })
            : t('desktop.home.appsStartSubtitle', {
                defaultValue: '应用独立存在。需要小Tin参与时，再从应用详情发起协作。',
              })}
        />

        <div className={cn(CONTEXT_PAGE_HEADER_GAP, 'flex flex-col gap-5')}>

        {/* ── 开始新的 ── */}
        {newActions.length > 0 && (
          <section className="flex flex-col gap-3">
            <span className={CANVAS_TEXT_EYEBROW}>
              {t('desktop.home.sectionNew')}
            </span>
            <div className="flex flex-wrap gap-2">
              {newActions.map(action => {
                const isCreating = creatingAppIds.has(action.id)
                return (
                  <Button
                    key={action.id}
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-[38px] gap-2 rounded-[9px] px-[13px]"
                    disabled={isCreating}
                    aria-busy={isCreating || undefined}
                    onClick={() => action.run()}
                  >
                    {isCreating
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : action.icon}
                    {action.label}
                  </Button>
                )
              })}
            </div>
          </section>
        )}

        {/* ── 最近使用：来自资源访问时间，不拿当前标签冒充历史 ── */}
        <section className="flex flex-col gap-3">
          <span className={CANVAS_TEXT_EYEBROW}>
            {t('desktop.home.sectionRecent', { defaultValue: '最近使用' })}
          </span>
          {recentItems.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(240px,100%),1fr))] gap-3">
              {recentItems.map(item => {
                const host = typeof item.meta?.url === 'string' && item.meta.url
                  ? (() => {
                      try { return new URL(item.meta.url as string).hostname }
                      catch { return null }
                    })()
                  : null
                return (
                  <button
                    key={item.tabKey}
                    type="button"
                    onClick={() => onSelectItem(item)}
                    className="group flex min-h-[96px] items-center gap-3.5 rounded-[12px] border border-border/60 bg-background p-4 text-left transition-[border-color,box-shadow] hover:border-border hover:shadow-sm"
                  >
                    <span className={cn(
                      'flex h-14 w-14 shrink-0 items-center justify-center rounded-[13px] text-muted-foreground/80 [&>span]:h-10 [&>span]:w-10 [&>svg]:h-10 [&>svg]:w-10',
                      resolveAppIconPresentation(item.type) !== 'selfContained' && 'bg-muted',
                    )}>
                      {contextRegistry.getTabIcon(item)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-body text-foreground">
                        {/* 与侧栏标签行同源：优先 handler.getTabLabel（如 tabphone 的
                            i18n 应用名），避免持久化的历史 title 漂移。 */}
                        {contextRegistry.getTabLabel(item) || t('label.newTab')}
                      </span>
                      {host && (
                        <span className={cn('truncate', CANVAS_TEXT_META)}>{host}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <p className={cn('rounded-[12px] border border-border/60 px-4 py-6 text-center', CANVAS_TEXT_SECONDARY)}>
              {t('desktop.home.recentEmpty', { defaultValue: '最近还没有打开过应用内容' })}
            </p>
          )}
        </section>

        {/* ── 全部应用 ── */}
        <section className="flex flex-col gap-3">
          <span className={CANVAS_TEXT_EYEBROW}>
            {t('desktop.home.sectionAllApps', { defaultValue: '全部应用' })}
          </span>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-3">
            {executionRootEntry ? (
              <button
                key="workspace-execution-root"
                type="button"
                title={executionRootEntry.workingDir}
                onClick={openExecutionRoot}
                className="group flex min-h-[124px] flex-col items-center justify-center gap-2.5 rounded-[12px] border border-border/60 bg-muted/30 px-4 py-4 text-center transition-colors hover:border-border hover:bg-background"
              >
                <span className="text-muted-foreground transition-colors group-hover:text-foreground">
                  <SidebarTypeEmoji appIdOrType={executionRootEntry.appId} className="h-12 w-12" />
                </span>
                <span className="max-w-full truncate text-body text-foreground/80 transition-colors group-hover:text-foreground">
                  {executionRootEntry.label}
                </span>
              </button>
            ) : null}
            {allAppEntries.map(entry => (
              <button
                key={entry.id}
                type="button"
                onClick={() => activateApp(entry)}
                className="group flex min-h-[124px] flex-col items-center justify-center gap-2.5 rounded-[12px] border border-border/60 bg-muted/30 px-4 py-4 text-center transition-colors hover:border-border hover:bg-background"
              >
                <span className="text-muted-foreground transition-colors group-hover:text-foreground [&>span]:h-12 [&>span]:w-12">
                  {entry.icon}
                </span>
                <span className="max-w-full truncate text-body text-foreground/80 transition-colors group-hover:text-foreground">
                  {entry.label}
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => onOpenAppHome(DESKTOP_APPS_HOME_ID)}
              className="group flex min-h-[124px] flex-col items-center justify-center gap-2.5 rounded-[12px] border border-dashed border-border/60 px-4 py-4 text-center transition-colors hover:bg-muted/30"
            >
              <span className="text-muted-foreground transition-colors group-hover:text-foreground">
                <SidebarTypeEmoji appIdOrType="desktop-apps" className="h-12 w-12" />
              </span>
              <span className="text-body text-muted-foreground transition-colors group-hover:text-foreground">
                {t('desktop.home.pinnedManage', { defaultValue: '管理快捷入口' })}
              </span>
              <span className={cn('max-w-[9rem]', CANVAS_TEXT_META)}>
                {t('desktop.home.pinnedManageHint', {
                  defaultValue: '打开更多应用，用图钉自定义侧栏快捷',
                })}
              </span>
            </button>
          </div>
        </section>
        </div>
      </div>
      </div>
    </div>
  )
}

DesktopHomePane.displayName = 'DesktopHomePane'
