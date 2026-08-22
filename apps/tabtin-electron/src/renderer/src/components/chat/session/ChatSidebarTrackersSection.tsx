/**
 * ChatSidebarTrackersSection — Chat sidebar 内的自动化区域(charter v1.8 §6.9)
 *
 * 双入口共存：Chat sidebar 内的自动化入口（快捷查看 + 创建）+ 独立自动化模块（深度管理）。
 * 数据来源严格复用 useTrackerStore — 与 自动化模块共享同一份 Service 数据。
 *
 * Wave 5 (charter v1.8 §3.4): 命名严守“自动化”(charter 词典封闭原则)。
 *
 * trackers_section_marker for grep validation: TrackersSection / 自动化区
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useTrackerListState, useTrackerStore } from '@/stores/useTrackerStore'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useAppPageStore } from '@stores/useAppPageStore'
import {
  openAutomationWorkbench,
  toInlineDetailFromTask,
  useTrackerAutomationNavStore,
} from '@components/tabtracker/trackerDetailNavigation'
// useSpaceContextTabsStore 已不再用于侧栏打开路径
import { cn } from '@utils/cn'
import { migrateLegacyLocalStorageKey } from '@utils/localStorageMigration'
import type { ChatSession, TrackerRunMeta } from '@tabtin/chat-client'
import type { TrackerTask } from '@/services/trackerApi'
import { displayFromRunStatus } from '@/services/trackerRunStatus'
import {
  formatAutomationRunTime,
  isAutomationListTrigger,
  isScheduledAutomationTrigger,
  toScheduledAutomationStatus,
} from '@components/tabtracker/scheduledAutomation'
import {
  SIDEBAR_ROW_LABEL,
  SIDEBAR_ROW_LABEL_GROW,
  SIDEBAR_ROW_LABEL_ACTIVE,
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_SECTION_LABEL,
  SIDEBAR_DIVIDER_BOTTOM,
  SIDEBAR_CHEVRON,
  SIDEBAR_ICON_SM,
  SIDEBAR_LIST_ICON,
  SIDEBAR_LIST_ICON_SIZE,
  SIDEBAR_LIST_ICON_SLOT,
  SIDEBAR_MENU_ICON_STROKE,
  SIDEBAR_META,
  SIDEBAR_COUNT,
  SIDEBAR_INLINE_ACTION,
  SIDEBAR_ROW_FULL_WIDTH,
  SIDEBAR_ROW_LIST,
  SIDEBAR_SECTION_BLOCK,
  SIDEBAR_CHEVRON_TRAILING,
} from '@components/layout/sidebarUi'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { ConfirmDialog, toast } from '@components/ui'

// 第 3 级 run 行：在 SidebarMenuItem 基础上左缩进一档（chevron + 状态点对齐）。
const RUN_ROW_CLASS = 'gap-1.5 pl-8 pr-2 cursor-pointer'

const MAX_VISIBLE_RUNS = 5

const RUN_STATUS_DOT: Record<ReturnType<typeof displayFromRunStatus>, string> = {
  running: 'bg-blue-500/80',
  success: 'bg-success',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground/40',
  pending: 'bg-warning',
}

const EMPTY_RUN_SESSIONS: ChatSession[] = []

// 状态圆点 token 化（PRD v2 §5.3.1）：draft 用 blue 与 TrackerListView /
// TrackerTaskList / TrackerDetail 主视图蓝点对齐——同一颜色跨视图代表
// "草稿"，避免详情页和侧栏视觉打架。
const STATUS_DOT: Record<string, string> = {
  active: 'bg-success',
  paused: 'bg-warning',
  archived: 'bg-muted-foreground/30',
}

const COLLAPSED_KEY_BASE = 'tabtin:chat-sidebar:trackers-collapsed'
// 每个 tracker 行的展开态（第 2→3 级展开），按 organization 命名空间隔离。
const EXPANDED_KEY_BASE = 'tabtin:chat-sidebar:trackers-expanded'

function buildCollapsedKey(organizationId: string | null | undefined): string {
  return organizationId ? `${COLLAPSED_KEY_BASE}:${organizationId}` : COLLAPSED_KEY_BASE
}

function loadCollapsed(organizationId: string | null | undefined): boolean {
  try {
    return localStorage.getItem(buildCollapsedKey(organizationId)) === 'true'
  } catch {
    return false
  }
}

function buildExpandedKey(organizationId: string | null | undefined): string {
  return organizationId ? `${EXPANDED_KEY_BASE}:${organizationId}` : EXPANDED_KEY_BASE
}

function loadExpanded(organizationId: string | null | undefined): Set<string> {
  try {
    const raw = localStorage.getItem(buildExpandedKey(organizationId))
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch { /* ignore */ }
  return new Set()
}

interface SidebarAutomationTask {
  id: string
  name: string
  status: 'active' | 'paused' | 'archived'
  task: TrackerTask | null
  archived: boolean
}

function belongsToScheduledAutomation(meta?: TrackerRunMeta | null): boolean {
  if (!meta) return false
  if (meta.tracker_trigger_type) {
    return isAutomationListTrigger(meta.tracker_trigger_type)
  }
  return meta.trigger_type === 'scheduled' || isScheduledAutomationTrigger(meta.trigger_type)
}

interface ChatSidebarTrackersSectionProps {
  spaceId: string
  onSelectRun: (spaceId: string, sessionId: string) => void | Promise<void>
  onDeleteArchivedRuns?: (spaceId: string, sessionIds: string[]) => void | Promise<void>
  /**
   * 当前工作台 scope（可为 `conversation:S`）；与稳定 draft scope 解耦。
   */
  tabScopeKey?: string
}

export const ChatSidebarTrackersSection: React.FC<ChatSidebarTrackersSectionProps> = React.memo(({
  spaceId,
  onSelectRun,
  onDeleteArchivedRuns,
}) => {
  const { t } = useTranslation('tabtracker')
  const organizationId = useResolvedOrganizationId()
  // 侧栏 WORKSPACE 点选会更新 selectedSpace，但本组件 props.spaceId 仍可能是
  // 会话列表根 Space（常为「默认 Space」）。新建/打开模块必须跟当前高亮 Space 对齐。
  const selectedSpace = useSpaceStore(s => s.selectedSpace)
  const effectiveSpaceId = useMemo(() => {
    if (
      selectedSpace?.id
      && !selectedSpace.is_archived
      && selectedSpace.type !== 'team_space'
      && (!organizationId || selectedSpace.organization_id === organizationId)
    ) {
      return selectedSpace.id
    }
    return spaceId
  }, [selectedSpace, organizationId, spaceId])
  const { tasks } = useTrackerListState(organizationId, effectiveSpaceId)
  const loadTasks = useTrackerStore.getState().loadTasks
  const setDialogState = useTrackerStore(s => s.setDialogState)

  // 第 3 级 run 数据：复用 ChatSessionSwitcher「自动化任务执行记录」分组同一份
  // 懒加载缓存（store 用 trackerRunLoadedBySpaceId 去重，跨入口命中同一份）。
  const trackerRunSessions = useChatStore(
    useCallback((s) => s.trackerRunSessionsBySpaceId[effectiveSpaceId] ?? EMPTY_RUN_SESSIONS, [effectiveSpaceId]),
  )
  const trackerRunsLoading = useChatStore(
    useCallback((s) => s.trackerRunLoadingBySpaceId[effectiveSpaceId] ?? false, [effectiveSpaceId]),
  )
  const trackerRunsError = useChatStore(
    useCallback((s) => s.trackerRunErrorBySpaceId[effectiveSpaceId] ?? null, [effectiveSpaceId]),
  )
  const trackerRunsLoaded = useChatStore(
    useCallback((s) => s.trackerRunLoadedBySpaceId[effectiveSpaceId] ?? false, [effectiveSpaceId]),
  )
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const loadTrackerRunSessions = useChatStore(s => s.loadTrackerRunSessions)
  const activePage = useAppPageStore(s => s.activePage)
  const automationDetailTaskId = useTrackerAutomationNavStore(s => s.detail?.taskId ?? null)

  const [collapsed, setCollapsed] = useState<boolean>(() => loadCollapsed(organizationId))
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded(organizationId))
  const [deleteTarget, setDeleteTarget] = useState<{
    sessionIds: string[]
  } | null>(null)

  useEffect(() => {
    if (organizationId) {
      migrateLegacyLocalStorageKey(COLLAPSED_KEY_BASE, buildCollapsedKey(organizationId))
      migrateLegacyLocalStorageKey(EXPANDED_KEY_BASE, buildExpandedKey(organizationId))
    }
  }, [organizationId])

  useEffect(() => {
    setCollapsed(loadCollapsed(organizationId))
    setExpanded(loadExpanded(organizationId))
  }, [organizationId])

  useEffect(() => {
    if (organizationId && effectiveSpaceId) {
      void loadTasks(organizationId, effectiveSpaceId)
    }
  }, [organizationId, effectiveSpaceId, loadTasks])

  // 左侧需要用历史会话重建已删除但有 Run 的任务节点，因此进入当前工作空间后
  // 就加载 Run 索引；仍复用 Chat Store 的按 Space 缓存，不重复请求。
  useEffect(() => {
    if (!effectiveSpaceId || trackerRunsLoaded) return
    void loadTrackerRunSessions(effectiveSpaceId, organizationId ?? undefined)
  }, [
    effectiveSpaceId,
    organizationId,
    trackerRunsLoaded,
    loadTrackerRunSessions,
  ])

  // run sessions 按 tracker_id 归组，每组按 run_index 倒序（最新在上）。
  const runsByTracker = useMemo(() => {
    const map = new Map<string, ChatSession[]>()
    for (const session of trackerRunSessions) {
      const trackerId = session.tracker_run?.tracker_id
      if (!trackerId) continue
      const arr = map.get(trackerId)
      if (arr) arr.push(session)
      else map.set(trackerId, [session])
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (b.tracker_run?.run_index ?? 0) - (a.tracker_run?.run_index ?? 0))
    }
    return map
  }, [trackerRunSessions])

  const toggleExpand = useCallback((taskId: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      const wasExpanded = next.has(taskId)
      if (wasExpanded) next.delete(taskId)
      else next.add(taskId)
      try {
        localStorage.setItem(buildExpandedKey(organizationId), JSON.stringify([...next]))
      } catch { /* ignore */ }
      // 首次展开任意 tracker 时触发懒加载（幂等，命中缓存即跳过）。
      if (!wasExpanded) {
        void loadTrackerRunSessions(effectiveSpaceId, organizationId ?? undefined)
      }
      return next
    })
  }, [organizationId, effectiveSpaceId, loadTrackerRunSessions])

  const handleSelectRun = useCallback((sessionId: string) => {
    if (!effectiveSpaceId) return
    void onSelectRun(effectiveSpaceId, sessionId)
  }, [effectiveSpaceId, onSelectRun])

  const handleRetryRuns = useCallback(() => {
    void loadTrackerRunSessions(effectiveSpaceId, organizationId ?? undefined, { force: true })
  }, [effectiveSpaceId, organizationId, loadTrackerRunSessions])

  const sortedTasks = useMemo<SidebarAutomationTask[]>(() => {
    // 是否为“已删除”必须和完整当前任务集比较，避免把仍存在但被产品隐藏的
    // Webhook/表格事件/扩展事件任务误判成归档自动化任务。
    const currentTaskIds = new Set(tasks.map(task => task.id))
    const currentVisible = tasks
      .filter(task => isAutomationListTrigger(task.trigger_type))
      .map(task => ({
        id: task.id,
        name: task.name,
        status: toScheduledAutomationStatus(task.status),
        task,
        archived: false,
      }) satisfies SidebarAutomationTask)

    const archived: SidebarAutomationTask[] = []
    for (const [trackerId, runSessions] of runsByTracker) {
      if (currentTaskIds.has(trackerId)) continue
      // Run 的 trigger_type 是执行来源（scheduled/manual/retry/event），不是任务的
      // cron/interval/at 配置。新服务端直接返回原任务类型；旧服务端降级用 scheduled
      // Run 推断，保证桌面端与后端滚动发布期间仍可读历史。
      const meta = runSessions
        .map(session => session.tracker_run)
        .find(belongsToScheduledAutomation)
      if (!meta) continue
      archived.push({
        id: trackerId,
        name: meta.tracker_name || t('list.untitled', { defaultValue: '未命名' }),
        status: 'archived',
        task: null,
        archived: true,
      })
    }

    const rank = { active: 0, paused: 1, archived: 2 } as const
    return [...currentVisible, ...archived].sort((a, b) => {
      const statusDiff = rank[a.status] - rank[b.status]
      return statusDiff || a.name.localeCompare(b.name)
    })
  }, [runsByTracker, t, tasks])

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev
      try {
        localStorage.setItem(buildCollapsedKey(organizationId), String(next))
      } catch { /* ignore */ }
      return next
    })
  }

  const handleOpenDetail = (item: SidebarAutomationTask) => {
    if (!effectiveSpaceId || !item.task) return
    openAutomationWorkbench(toInlineDetailFromTask(item.task, effectiveSpaceId))
  }

  const handleOpenTrackerHome = useCallback(() => {
    if (!effectiveSpaceId) return
    openAutomationWorkbench()
  }, [effectiveSpaceId])

  const handleOpenCreate = useCallback(() => {
    handleOpenTrackerHome()
    // 带上当前选中 Space，避免全局 dialog 被其它 TrackerPanel（常为默认 Space）抢开
    setDialogState({ open: true, createSpaceId: effectiveSpaceId })
  }, [handleOpenTrackerHome, setDialogState, effectiveSpaceId])

  return (
    <div
      className={cn(SIDEBAR_DIVIDER_BOTTOM, SIDEBAR_SECTION_BLOCK)}
      data-testid="chat-sidebar-trackers-section"
    >
      {/* 与 WORKSPACE 分区标题同款：SIDEBAR_SECTION_HEADER（mx-1.5 + px-1.5 → 20px 左缘） */}
      <div className={cn(SIDEBAR_SECTION_HEADER, SIDEBAR_ROW_FULL_WIDTH, 'flex items-center gap-1')}>
        <button
          type="button"
          onClick={handleOpenTrackerHome}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-interactive text-left transition-colors hover:text-foreground"
          aria-label={t('chatSidebar.openModule', { defaultValue: '打开自动化模块' })}
        >
          <span className={cn(SIDEBAR_SECTION_LABEL, 'min-w-0 flex-1')}>
            {t('chatSidebar.trackersSection', { defaultValue: '自动化' })}
            {sortedTasks.length > 0 && (
              <span className={cn('ml-1 normal-case tracking-normal', SIDEBAR_COUNT)}>
                ({sortedTasks.length})
              </span>
            )}
          </span>
        </button>
        <ChatIconTooltip content={t('chatSidebar.newTracker', { defaultValue: '+ 新建自动化任务' })}>
          <button
            type="button"
            onClick={handleOpenCreate}
            className={SIDEBAR_INLINE_ACTION}
            aria-label={t('chatSidebar.newTracker', { defaultValue: '+ 新建自动化任务' })}
          >
            <Plus className={SIDEBAR_ICON_SM} />
          </button>
        </ChatIconTooltip>
        <button
          type="button"
          onClick={toggleCollapsed}
          className={SIDEBAR_CHEVRON_TRAILING}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('chatSidebar.expandSection', { defaultValue: '展开自动化' }) : t('chatSidebar.collapseSection', { defaultValue: '收起自动化' })}
        >
          {collapsed ? (
            <ChevronRight className={SIDEBAR_CHEVRON} aria-hidden />
          ) : (
            <ChevronDown className={SIDEBAR_CHEVRON} aria-hidden />
          )}
        </button>
      </div>

      {!collapsed && (
        <div className={cn(SIDEBAR_ROW_LIST, 'pb-1')}>
          {sortedTasks.length === 0 ? (
            <SidebarMenuItem
              onClick={handleOpenCreate}
              fullWidth
              data-testid="chat-sidebar-trackers-empty-create"
            >
              <span className={SIDEBAR_LIST_ICON_SLOT}>
                <Plus
                  size={SIDEBAR_LIST_ICON_SIZE}
                  className={SIDEBAR_LIST_ICON}
                  strokeWidth={SIDEBAR_MENU_ICON_STROKE}
                  aria-hidden
                />
              </span>
              <span className={SIDEBAR_ROW_LABEL_GROW}>
                {t('chatSidebar.emptyHint', { defaultValue: '创建首个自动化任务' })}
              </span>
            </SidebarMenuItem>
          ) : (
            <>
              {sortedTasks.map(item => {
                const isExpanded = expanded.has(item.id)
                const taskRuns = runsByTracker.get(item.id) ?? []
                const visibleRuns = item.archived ? taskRuns : taskRuns.slice(0, MAX_VISIBLE_RUNS)
                const hiddenRuns = item.archived ? 0 : Math.max(0, taskRuns.length - MAX_VISIBLE_RUNS)
                const isTaskActive = activePage === 'automation' && automationDetailTaskId === item.id
                return (
                  <div key={item.id} className="min-w-0">
                    <SidebarMenuItem
                      as="div"
                      className="pr-1.5"
                      active={isTaskActive}
                      data-testid={`chat-sidebar-tracker-row-${item.id}`}
                    >
                      {item.archived ? (
                        <div
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground"
                          aria-label={t('chatSidebar.archivedTask', { defaultValue: '已删除任务，仅保留历史执行记录' })}
                          data-testid={`chat-sidebar-tracker-archived-${item.id}`}
                        >
                          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT.archived)} aria-hidden />
                          <span className={SIDEBAR_ROW_LABEL_GROW}>
                            {item.name || t('list.untitled', { defaultValue: '未命名' })}
                          </span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleOpenDetail(item)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          aria-label={t('chatSidebar.openTaskDetail', { defaultValue: '打开任务详情' })}
                          data-testid={`chat-sidebar-tracker-detail-${item.id}`}
                        >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            STATUS_DOT[item.status],
                          )}
                          aria-hidden
                        />
                        <span className={cn(SIDEBAR_ROW_LABEL_GROW, isTaskActive && SIDEBAR_ROW_LABEL_ACTIVE)}>
                          {item.name || t('list.untitled', { defaultValue: '未命名' })}
                        </span>
                        </button>
                      )}
                      {trackerRunsLoaded && taskRuns.length > 0 && (
                        <span className={SIDEBAR_COUNT}>{taskRuns.length}</span>
                      )}
                      {item.archived && taskRuns.length > 0 && onDeleteArchivedRuns ? (
                        <ChatIconTooltip content={t('chatSidebar.deleteHistory', { defaultValue: '删除历史记录' })}>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              setDeleteTarget({
                                sessionIds: taskRuns.map(run => run.id),
                              })
                            }}
                            className={cn(SIDEBAR_INLINE_ACTION, 'text-destructive/80 hover:text-destructive')}
                            aria-label={t('chatSidebar.deleteHistory', { defaultValue: '删除历史记录' })}
                          >
                            <Trash2 className={SIDEBAR_ICON_SM} aria-hidden />
                          </button>
                        </ChatIconTooltip>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => toggleExpand(item.id)}
                        className={SIDEBAR_CHEVRON_TRAILING}
                        aria-expanded={isExpanded}
                        aria-label={
                          isExpanded
                            ? t('chatSidebar.collapseRuns', { defaultValue: '收起执行记录' })
                            : t('chatSidebar.expandRuns', { defaultValue: '展开执行记录' })
                        }
                        data-testid={`chat-sidebar-tracker-toggle-${item.id}`}
                      >
                        {isExpanded ? (
                          <ChevronDown className={SIDEBAR_CHEVRON} aria-hidden />
                        ) : (
                          <ChevronRight className={SIDEBAR_CHEVRON} aria-hidden />
                        )}
                      </button>
                    </SidebarMenuItem>

                    {isExpanded && (
                      <div className={SIDEBAR_ROW_LIST}>
                        {!trackerRunsLoaded && trackerRunsError ? (
                          <SidebarMenuItem as="div" className={cn(RUN_ROW_CLASS, 'cursor-default')}>
                            <AlertCircle className="h-3 w-3 shrink-0 text-destructive/80" />
                            <span className={cn(SIDEBAR_ROW_LABEL, 'text-destructive/80 flex-1')}>
                              {t('chatSidebar.runsError', { defaultValue: '加载失败' })}
                            </span>
                            <ChatIconTooltip content={t('chatSidebar.runsRetry', { defaultValue: '重试' })}>
                              <button
                                type="button"
                                onClick={handleRetryRuns}
                                className={SIDEBAR_INLINE_ACTION}
                                aria-label={t('chatSidebar.runsRetry', { defaultValue: '重试' })}
                              >
                                <RotateCcw className={SIDEBAR_ICON_SM} />
                              </button>
                            </ChatIconTooltip>
                          </SidebarMenuItem>
                        ) : !trackerRunsLoaded ? (
                          <SidebarMenuItem as="div" className={cn(RUN_ROW_CLASS, 'cursor-default')}>
                            <Loader2
                              className={cn(
                                'h-3 w-3 shrink-0 text-muted-foreground/60',
                                trackerRunsLoading && 'animate-spin',
                              )}
                              aria-hidden
                            />
                            <span className={cn(SIDEBAR_ROW_LABEL, 'text-muted-foreground/60')}>
                              {t('chatSidebar.runsLoading', { defaultValue: '加载执行记录…' })}
                            </span>
                          </SidebarMenuItem>
                        ) : taskRuns.length === 0 ? (
                          <SidebarMenuItem as="div" className={cn(RUN_ROW_CLASS, 'cursor-default')}>
                            <span className={cn(SIDEBAR_ROW_LABEL, 'text-muted-foreground/60')}>
                              {t('chatSidebar.runsEmpty', { defaultValue: '暂无执行记录' })}
                            </span>
                          </SidebarMenuItem>
                        ) : (
                          <>
                            {visibleRuns.map(run => {
                              const meta = run.tracker_run
                              const display = displayFromRunStatus(meta?.run_status)
                              const isActive = activePage !== 'automation' && run.id === currentSessionId
                              const time = formatAutomationRunTime(meta?.started_at ?? run.created_at)
                              const label =
                                time
                                || run.title
                                || t('list.untitled', { defaultValue: '未命名' })
                              return (
                                <SidebarMenuItem
                                  key={run.id}
                                  as="div"
                                  role="button"
                                  tabIndex={0}
                                  active={isActive}
                                  className={RUN_ROW_CLASS}
                                  onClick={() => handleSelectRun(run.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault()
                                      handleSelectRun(run.id)
                                    }
                                  }}
                                  title={label}
                                  data-testid={`chat-sidebar-tracker-run-${run.id}`}
                                >
                                  <span
                                    className={cn('h-1.5 w-1.5 shrink-0 rounded-full', RUN_STATUS_DOT[display])}
                                    aria-hidden
                                  />
                                  <span
                                    className={cn(
                                      SIDEBAR_ROW_LABEL_GROW,
                                      'tabular-nums',
                                      isActive && SIDEBAR_ROW_LABEL_ACTIVE,
                                    )}
                                  >
                                    {label}
                                  </span>
                                </SidebarMenuItem>
                              )
                            })}
                            {hiddenRuns > 0 && (
                              <SidebarMenuItem
                                onClick={() => handleOpenDetail(item)}
                                className={RUN_ROW_CLASS}
                              >
                                <span className={cn(SIDEBAR_ROW_LABEL_GROW, SIDEBAR_META)}>
                                  {t('chatSidebar.viewAllRuns', {
                                    defaultValue: '查看全部 ({{count}})',
                                    count: taskRuns.length,
                                  })}
                                </span>
                              </SidebarMenuItem>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={t('chatSidebar.deleteHistoryTitle', { defaultValue: '删除自动化历史' })}
        description={t('chatSidebar.deleteHistoryHint', {
          defaultValue: '将永久删除该任务的全部执行记录和对应对话，无法恢复。',
        })}
        confirmText={t('chatSidebar.deleteHistory', { defaultValue: '删除历史记录' })}
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget || !onDeleteArchivedRuns) return
          try {
            await onDeleteArchivedRuns(effectiveSpaceId, deleteTarget.sessionIds)
            toast.success(t('chatSidebar.deleteHistorySuccess', { defaultValue: '历史记录已删除' }))
          } catch {
            toast.error(t('chatSidebar.deleteHistoryFailed', { defaultValue: '删除失败，请重试' }))
          } finally {
            setDeleteTarget(null)
          }
        }}
      />
    </div>
  )
})
ChatSidebarTrackersSection.displayName = 'ChatSidebarTrackersSection'
