/**
 * CollapsedCanvasRail —— 对话模式下右侧画布折叠时的精简收起栏。
 *
 * - 上半：当前 Space 已打开的内容标签，点一个 → 展开画布并激活该标签。
 * - 下半（仅任务桌面）：Workspace 执行根（IDE / 目录，常驻首位）+ 用户置顶应用快捷入口
 *   + 底部「工作台」。消息会话不展示这块，避免和「会话资产」抢入口。
 *   点应用 → 展开画布并打开对应应用主页 / 新建；「工作台」展开画布并进入任务工作台
 *  （与清空 activeKey 后的对话空画布同源）。置顶名单可在工作台「管理置顶」里改，
 *   收起栏悬停也可取消置顶。
 *
 * 宽度随可用空间自适应：够宽显示「图标 + 文字」（整行 hover/active 底），窗口窄时
 * shell 把 `iconOnly` 置真，收起栏收成一列纯图标——此时 hover/active 底走「居中 32×32
 * 圆角方块」，而不是让 <button> 按内容收成竖条椭圆。数据/动作复用 SpaceContextArea +
 * 桌面模型，不重造。
 */
import React, { useCallback, useMemo } from 'react'
import { LayoutGrid, Paperclip, PinOff, Share2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { contextRegistry } from './registry'
import type { ContextItem } from './registry/types'
import { useSpaceContextState, useSpaceContextActions } from './SpaceContextAreaContext'
import { useSpaceApps } from '@stores/useSpaceApps'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useIMStore } from '@stores/useIMStore'
import { CONVERSATION_TYPE_DM } from '@/constants/tabchat'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import {
  conversationIdFromImScopeKey,
  sessionIdFromConversationScopeKey,
} from '@components/layout/workspaceContextState'
import { DESKTOP_TAB_KEY, DESKTOP_TAB_TYPE } from './desktopTabHandler'
import { buildImAssetsId, IM_ASSETS_TAB_TYPE, type ImAssetKind } from './imAssetsTab'
import {
  useDesktopAppEntries,
  usePinnedDesktopAppIds,
  DESKTOP_RAIL_EXCLUDED_APP_IDS,
  type DesktopAppEntry,
} from './desktopAppsModel'
import { useCanvasRailPortal } from '@components/layout/CanvasRailPortalContext'
import {
  CANVAS_TEXT_META,
} from '@components/layout/canvasUi'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@components/ui'
import {
  SIDEBAR_CANVAS_RAIL_ROW,
  SIDEBAR_EMPTY_STATE,
  SIDEBAR_ROW_ACTIVE,
  SIDEBAR_ROW_INACTIVE,
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_SECTION_LABEL,
} from '@components/layout/sidebarUi'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { useSessionAccessStore } from '@/stores/chat/session/sessionAccessStore'
import {
  buildWorkspaceExecutionRootEntry,
  openWorkspaceExecutionRoot,
  resolveExecutionView,
  resolveWorkspaceWorkingDir,
  resolveWorkspaceWorkingDirType,
} from './workspaceExecutionRootApp'
import { CodeWorkspaceRailCard } from './code-workspace/CodeWorkspaceRailCard'
import { useChatStore } from '@stores/chat/useChatStore'
import { resolveSessionCodeRoot } from '@/stores/chat/utils/resolveSessionCodeRoot'
import { useSessionBoundCodeRootStore } from '@stores/useSessionBoundCodeRootStore'

// 「打开的标签」= 用户真实打开的标签。只排桌面虚拟占位标签；apphome（应用主页，如从下方
// 「文档/云盘」入口点开的列表页）也是打开的标签，必须显示——否则点应用打开后这里会空白。
// 工作台由底部常驻入口承载（清 activeKey → DesktopHomePane），不进打开标签列表。
const EXCLUDED_TAB_TYPES = new Set<string>([DESKTOP_TAB_TYPE, IM_ASSETS_TAB_TYPE])

// 图标态下承载 hover/active 底的方块（居中，宽高相等 → 圆角方块而非竖条椭圆）。
const ICON_TILE_INACTIVE = 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]'

const RailRowTooltip: React.FC<{
  content: string
  children: React.ReactElement
}> = ({ content, children }) => (
  <TooltipProvider delayDuration={250}>
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-[280px] whitespace-normal break-words">
        {content}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
)

interface CollapsedCanvasRailProps {
  expandCanvas: () => void
}

interface RailRow {
  key: string
  label: string
  title?: string
  subLabel?: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
  compact?: boolean
}

export const CollapsedCanvasRail: React.FC<CollapsedCanvasRailProps> = ({ expandCanvas }) => {
  const { t } = useTranslation('context')
  const { iconOnly } = useCanvasRailPortal()
  const { visibleItems, activeTabKey, spaceId, tabScopeKey } = useSpaceContextState()
  const { onSelectItem, onOpenAppHome, onSelectHome, createHandlers } = useSpaceContextActions()
  const spaceApps = useSpaceApps(state => state.appsBySpace[spaceId])
  const appEntries = useDesktopAppEntries(t, spaceApps)
  const { pinnedAppIds, unpinApp } = usePinnedDesktopAppIds()
  const imConversationId = conversationIdFromImScopeKey(tabScopeKey)
  const conversationSessionId = sessionIdFromConversationScopeKey(tabScopeKey)
  const spaceSessionId = useChatStore((s) =>
    spaceId ? (s.currentSessionIdBySpaceId[spaceId] ?? null) : null,
  )
  const codeWorkspaceSessionId = conversationSessionId || spaceSessionId
  const isSharedSession = useSessionAccessStore(state => Boolean(
    conversationSessionId && state.bySessionId[conversationSessionId],
  ))
  // 「共享对话」入口仅 DM 展示：共享授权是「我 ↔ 对端」的用户对关系，群聊无单一对端
  const isDmConversation = useIMStore((state) =>
    imConversationId
      ? state.conversations.find((c) => c.id === imConversationId)?.type === CONVERSATION_TYPE_DM
      : false,
  )

  const assetEntries = useMemo(() => {
    if (!imConversationId || isSharedSession) return []
    const entries: Array<{ kind: ImAssetKind; label: string; icon: React.ReactNode }> = [
      {
        kind: 'document' as const,
        label: t('canvasRail.assetDocuments', { defaultValue: '云盘' }),
        icon: <TabTypeEmoji appIdOrType="cloud-resources" />,
      },
      {
        kind: 'file' as const,
        label: t('canvasRail.assetFiles', { defaultValue: '文件' }),
        icon: <Paperclip className="h-[1em] w-[1em]" />,
      },
    ]
    if (isDmConversation) {
      entries.push({
        kind: 'shared_session' as const,
        label: t('canvasRail.assetSharedSessions', { defaultValue: '共享对话' }),
        icon: <Share2 className="h-[1em] w-[1em]" />,
      })
    }
    return entries
  }, [imConversationId, isDmConversation, isSharedSession, t])

  const handleOpenAsset = useCallback((kind: ImAssetKind, label: string) => {
    if (!imConversationId) return
    expandCanvas()
    useSpaceContextTabsStore.getState().openResourceTab(tabScopeKey, {
      type: IM_ASSETS_TAB_TYPE,
      id: buildImAssetsId(kind, imConversationId),
      title: label,
      meta: { conversationId: imConversationId, kind, spaceId },
    })
  }, [expandCanvas, imConversationId, spaceId, tabScopeKey])
  // 底部「工作台」：展开画布并清 activeKey，对话模式落到任务工作台（DesktopHomePane）。
  // 置顶快捷在工作台内「管理置顶」改；不必再绕「更多应用 → 关标签」。
  const handleOpenWorkbench = useCallback(() => {
    expandCanvas()
    onSelectHome()
  }, [expandCanvas, onSelectHome])

  // Space.working_dir 优先，否则 Agent.working_dir；type 决定 IDE / 目录入口。
  // IDE（code）优先走会话绑定代码根，无绑定再回退 Workspace 根。
  const workspaceAgent = useSpaceStore(state => {
    const space = state.spaces.find(item => item.id === spaceId) ?? null
    if (space?.type !== 'workspace') return null
    const agentId = space.execution_agent_id ?? space.agent_id ?? null
    if (!agentId) return null
    return state.agentCache[agentId]
      ?? (state.selectedAgent?.id === agentId ? state.selectedAgent : null)
  })
  const spaceRecord = useSpaceStore(state => state.spaces.find(item => item.id === spaceId) ?? null)
  const workingDir = resolveWorkspaceWorkingDir(spaceRecord, workspaceAgent)
  const workingDirType = resolveWorkspaceWorkingDirType(spaceRecord, workspaceAgent)
  const boundRevision = useSessionBoundCodeRootStore((s) =>
    codeWorkspaceSessionId
      ? s.bindingsBySessionId[codeWorkspaceSessionId]?.revision ?? null
      : null,
  )
  const executionWorkingDir = useMemo(() => {
    void boundRevision
    if (resolveExecutionView(workingDirType) !== 'code') return workingDir
    return resolveSessionCodeRoot(codeWorkspaceSessionId, { spaceWorkingDir: workingDir })
      || workingDir
  }, [boundRevision, codeWorkspaceSessionId, workingDir, workingDirType])
  const executionRootEntry = useMemo(
    () => buildWorkspaceExecutionRootEntry({
      spaceId,
      workingDir: executionWorkingDir,
      workingDirType,
      t,
    }),
    [spaceId, t, executionWorkingDir, workingDirType],
  )

  const openTabs = useMemo(
    () => visibleItems.filter(item => !EXCLUDED_TAB_TYPES.has(item.type)),
    [visibleItems],
  )

  const isWorkbenchActive =
    !activeTabKey || activeTabKey === DESKTOP_TAB_KEY

  const pinnedEntries = useMemo(
    () => pinnedAppIds
      .filter(id => !DESKTOP_RAIL_EXCLUDED_APP_IDS.has(id))
      .map(id => appEntries.find(entry => entry.id === id))
      .filter((entry): entry is DesktopAppEntry => Boolean(entry)),
    [pinnedAppIds, appEntries],
  )

  const handleSelectTab = useCallback((item: ContextItem) => {
    expandCanvas()
    onSelectItem(item)
  }, [expandCanvas, onSelectItem])

  const handleActivateApp = useCallback((entry: DesktopAppEntry) => {
    expandCanvas()
    if (entry.mode === 'create') {
      createHandlers[entry.id]?.()
      return
    }
    onOpenAppHome(entry.id)
  }, [createHandlers, expandCanvas, onOpenAppHome])

  const handleOpenExecutionRoot = useCallback(() => {
    if (!executionRootEntry) return
    expandCanvas()
    openWorkspaceExecutionRoot({
      tabScopeKey,
      spaceId,
      workingDir: executionRootEntry.workingDir,
      view: executionRootEntry.view,
    })
  }, [executionRootEntry, expandCanvas, spaceId, tabScopeKey])

// 与 NormalTab 一致：外层控制 emoji 选中彩色 / 未选中静音，避免组件内置灰度叠两层。
const railTabIconClass = (active: boolean) => cn(
  'flex h-[1em] w-[1em] shrink-0 items-center justify-center grayscale',
  active ? 'grayscale-0 opacity-100' : 'opacity-60',
)

  const renderRow = useCallback((row: RailRow) => {
    const tip = row.title ?? row.label
    if (iconOnly) {
      // 图标态：button 撑满整栏做点击热区，底色收在居中的 32×32 圆角方块上。
      return (
        <RailRowTooltip key={row.key} content={tip}>
          <button
            type="button"
            title={tip}
            aria-label={tip}
            onClick={row.onClick}
            className="group flex w-full items-center justify-center py-0.5"
          >
            <span
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-interactive transition-colors',
                row.active ? SIDEBAR_ROW_ACTIVE : ICON_TILE_INACTIVE,
              )}
            >
              <span className={railTabIconClass(row.active)}>
                {row.icon}
              </span>
            </span>
          </button>
        </RailRowTooltip>
      )
    }
    if (row.compact) {
      return (
        <RailRowTooltip key={row.key} content={tip}>
          <button
            type="button"
            title={tip}
            onClick={row.onClick}
            className={cn(
              'group relative mx-1.5 flex w-fit max-w-[min(240px,calc(100%-0.75rem))] flex-col items-start overflow-hidden rounded-interactive px-2 py-1 text-left transition-colors',
              row.active ? SIDEBAR_ROW_ACTIVE : SIDEBAR_ROW_INACTIVE,
            )}
          >
            <span className="flex min-w-0 max-w-full items-center gap-2">
              <span className={railTabIconClass(row.active)}>
                {row.icon}
              </span>
              <span className={cn('truncate', CANVAS_TEXT_META)}>
                {row.label}
              </span>
            </span>
            {row.subLabel ? (
              <span className={cn('max-w-full truncate', CANVAS_TEXT_META)}>
                {row.subLabel}
              </span>
            ) : null}
          </button>
        </RailRowTooltip>
      )
    }
    return (
      <RailRowTooltip key={row.key} content={tip}>
        <button
          type="button"
          title={tip}
          onClick={row.onClick}
          className={cn(
            SIDEBAR_CANVAS_RAIL_ROW,
            row.active ? SIDEBAR_ROW_ACTIVE : SIDEBAR_ROW_INACTIVE,
          )}
        >
          <span className={railTabIconClass(row.active)}>
            {row.icon}
          </span>
          <span className="flex min-w-0 flex-1 flex-col text-left">
            <span className="truncate">
              {row.label}
            </span>
            {row.subLabel ? (
              <span className={cn('truncate text-muted-foreground/55', CANVAS_TEXT_META)}>
                {row.subLabel}
              </span>
            ) : null}
          </span>
        </button>
      </RailRowTooltip>
    )
  }, [iconOnly])

  const visibleExecutionRoot = imConversationId || isSharedSession ? null : executionRootEntry
  // 消息会话只保留「会话资产 + 打开的标签」；云盘/多维表/文档/工作台这类任务快捷入口留给任务桌面。
  const showBottom = !imConversationId && !isSharedSession

  return (
    <div
      data-testid="collapsed-canvas-rail"
      className="flex h-full w-full min-w-0 flex-col overflow-hidden pt-1"
    >
      {/* 顶：本会话分享过的云盘 / 文件入口。 */}
      {assetEntries.length > 0 && (
        <div className="min-w-0 shrink-0 space-y-0.5 pb-1">
          {!iconOnly && (
            <div className={SIDEBAR_SECTION_HEADER}>
              <span className={SIDEBAR_SECTION_LABEL}>
                {t('canvasRail.conversationAssets', { defaultValue: '会话资产' })}
              </span>
            </div>
          )}
          {assetEntries.map(entry => renderRow({
            key: `imasset:${entry.kind}`,
            label: entry.label,
            icon: entry.icon,
            active: activeTabKey === contextRegistry.buildTabKey(
              IM_ASSETS_TAB_TYPE,
              buildImAssetsId(entry.kind, imConversationId ?? ''),
            ),
            onClick: () => handleOpenAsset(entry.kind, entry.label),
          }))}
        </div>
      )}

      {/* 上：当前 Space 已打开的标签 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {!iconOnly && (
          <div className={SIDEBAR_SECTION_HEADER}>
            <span className={SIDEBAR_SECTION_LABEL}>
              {t('canvasRail.openTabs', { defaultValue: '打开的标签' })}
            </span>
          </div>
        )}
        {openTabs.length === 0 ? (
          !iconOnly && (
            <p className={cn(SIDEBAR_EMPTY_STATE, 'text-muted-foreground/60')}>
              {t('canvasRail.emptyTabs', { defaultValue: '打开文档、网页或终端后会显示在这里' })}
            </p>
          )
        ) : (
          <div className="min-h-0 min-w-0 flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden scrollbar-hover">
            {openTabs.map(item => renderRow({
              key: item.tabKey,
              label: contextRegistry.getTabLabel(item) || t('label.newTab', { defaultValue: '新标签' }),
              icon: contextRegistry.getTabIcon(item),
              active: item.tabKey === activeTabKey,
              onClick: () => handleSelectTab(item),
            }))}
          </div>
        )}
      </div>

      {/* 代码工作区：对话聚焦右侧快捷入口上方；IM / 共享会话不展示。 */}
      {showBottom ? (
        <CodeWorkspaceRailCard
          expandCanvas={expandCanvas}
          sessionId={codeWorkspaceSessionId}
        />
      ) : null}

      {/* 下：快捷入口；仅任务桌面露出。工作空间执行根常驻首位，用户置顶应用居中，工作台垫底。 */}
      {showBottom && (
        <div className="min-w-0 shrink-0 pb-1 pt-1">
          {!iconOnly && (
            <div className={SIDEBAR_SECTION_HEADER}>
              <span className={SIDEBAR_SECTION_LABEL}>
                {t('canvasRail.shortcuts', { defaultValue: '快捷入口' })}
              </span>
            </div>
          )}
          <div className="min-w-0 space-y-0.5">
            {visibleExecutionRoot ? renderRow({
              key: 'workspace-execution-root',
              label: visibleExecutionRoot.label,
              title: visibleExecutionRoot.workingDir,
              icon: <TabTypeEmoji appIdOrType={visibleExecutionRoot.appId} />,
              active: activeTabKey === visibleExecutionRoot.tabKey,
              onClick: handleOpenExecutionRoot,
            }) : null}
            {pinnedEntries.map(entry => {
              if (iconOnly) {
                return renderRow({
                  key: entry.id,
                  label: entry.label,
                  icon: entry.icon,
                  active: false,
                  onClick: () => handleActivateApp(entry),
                })
              }
              // 可取消置顶：外层用 div（避免 button 嵌套），与桌面侧栏置顶行同构。
              return (
                <RailRowTooltip key={entry.id} content={entry.label}>
                  <div
                    role="button"
                    tabIndex={0}
                    title={entry.label}
                    className={cn(
                      'group',
                      SIDEBAR_CANVAS_RAIL_ROW,
                      SIDEBAR_ROW_INACTIVE,
                    )}
                    onClick={() => handleActivateApp(entry)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        handleActivateApp(entry)
                      }
                    }}
                  >
                    <span className={railTabIconClass(false)}>
                      {entry.icon}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">
                      {entry.label}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 flex h-4 w-4 items-center justify-center rounded-interactive opacity-0 transition-opacity group-hover:opacity-100 hover:bg-foreground/[0.06]"
                      aria-label={t('desktop.sidebar.unpinApp', { app: entry.label, defaultValue: '取消置顶 {{app}}' })}
                      title={t('desktop.sidebar.unpinApp', { app: entry.label, defaultValue: '取消置顶 {{app}}' })}
                      onClick={event => {
                        event.stopPropagation()
                        unpinApp(entry.id)
                      }}
                    >
                      <PinOff className="h-2.5 w-2.5" />
                    </button>
                  </div>
                </RailRowTooltip>
              )
            })}
            {renderRow({
              key: 'workbench-home',
              label: t('canvasRail.apps', { defaultValue: '工作台' }),
              icon: <LayoutGrid className="h-[1em] w-[1em]" />,
              active: isWorkbenchActive,
              onClick: handleOpenWorkbench,
            })}
          </div>
        </div>
      )}
    </div>
  )
}

CollapsedCanvasRail.displayName = 'CollapsedCanvasRail'
