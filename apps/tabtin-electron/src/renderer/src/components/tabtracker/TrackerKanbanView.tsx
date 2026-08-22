/**
 * TrackerKanbanView — Tracker 模块的 Kanban 视图（charter v1.8 §3.2）
 *
 * 同一份 useTrackerStore 数据,按状态分列渲染。Charter §3.2 列定义: draft / active / paused / disabled。
 * Wave 5 阶段实现: 4 列横向布局,每列内 Tracker 卡片纵向排列。本期不做拖拽改状态。
 */

import React, { useEffect, useMemo } from 'react'
import { Layers, AlertCircle, Pause, CheckCircle2, Pencil, XCircle } from 'lucide-react'
import { ScrollArea, Button } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useTrackerListState, useTrackerStore } from '@/stores/useTrackerStore'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import type { TrackerTask } from '@/services/trackerApi'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import type { ResourceScope } from '@stores/useSpaceViewPrefsStore'
import { getTrackerListSpaceId, getTrackerTaskSpaceId } from './trackerScope'
import { TrackerSpaceBadge } from './TrackerSpaceBadge'

// charter v1.8 §3.2: Kanban 视图列定义
const KANBAN_COLUMNS = [
  {
    // D2 默认 draft（PRD v2 §5.3.1）：accent 用 amber 替代 muted —— 与
    // "已停用"（muted-foreground/40）拉开视觉距离，让用户在 Kanban 一眼看出
    // 哪些 Tracker 还未激活；与 STATUS_DOT.draft 同色系。
    key: 'draft' as const,
    labelKey: 'kanban.colDraft',
    defaultLabel: '草稿',
    icon: Pencil,
    accent: 'text-blue-600 dark:text-blue-400',
  },
  {
    key: 'active' as const,
    labelKey: 'kanban.colActive',
    defaultLabel: '已激活',
    icon: CheckCircle2,
    accent: 'text-green-600 dark:text-green-400',
  },
  {
    key: 'paused' as const,
    labelKey: 'kanban.colPaused',
    defaultLabel: '已暂停',
    icon: Pause,
    accent: 'text-yellow-600 dark:text-yellow-400',
  },
  {
    key: 'disabled' as const,
    labelKey: 'kanban.colDisabled',
    defaultLabel: '已停用',
    icon: XCircle,
    accent: 'text-muted-foreground/40',
  },
] as const

const TRIGGER_BADGE: Record<string, string> = {
  cron: '⏰',
  interval: '🔄',
  manual: '👆',
  webhook: '🔗',
  table_event: '📊',
  extension_event: '⚡',
}

function partitionByStatus(tasks: TrackerTask[]): Record<string, TrackerTask[]> {
  const buckets: Record<string, TrackerTask[]> = {
    draft: [],
    active: [],
    paused: [],
    disabled: [],
  }
  for (const task of tasks) {
    const key = (task.status ?? '').toLowerCase()
    if (key in buckets) {
      buckets[key].push(task)
    } else {
      // 未知状态归入 draft 兜底
      buckets.draft.push(task)
    }
  }
  return buckets
}

interface TrackerKanbanViewProps {
  spaceId: string
  tabScopeKey?: string
  resourceScope?: ResourceScope
}

/**
 * Wave 5 (charter v1.8 §3.2)：Kanban 视图组件 — 按 status 分列渲染同一份数据。
 * KanbanView marker for grep validation: charter v1.8 三视图（list / agenda / kanban）。
 */
export const TrackerKanbanView: React.FC<TrackerKanbanViewProps> = ({ spaceId, tabScopeKey, resourceScope = 'space' }) => {
  const { t } = useTranslation('tabtracker')
  const organizationId = useResolvedOrganizationId()
  const loadTasks = useTrackerStore.getState().loadTasks
  const openResourceTab = useSpaceContextTabsStore(s => s.openResourceTab)
  const effectiveTabScopeKey = tabScopeKey ?? resolveForegroundTabScopeKey(spaceId)
  const trackerListSpaceId = getTrackerListSpaceId(spaceId, resourceScope)
  const trackerList = useTrackerListState(organizationId, trackerListSpaceId)
  const { tasks, isLoading, loadError } = trackerList

  // effect 仅响应 scope 变化;并发与失败重试由 store 内部
  // (_inflightKey + _lastFailedKey 冷却) 兜底,避免依赖 isLoading 形成失败死循环。
  useEffect(() => {
    if (organizationId && spaceId) {
      void loadTasks(organizationId, trackerListSpaceId)
    }
  }, [organizationId, spaceId, trackerListSpaceId, loadTasks])

  const buckets = useMemo(() => partitionByStatus(tasks), [tasks])

  const handleOpenDetail = (task: TrackerTask) => {
    if (!spaceId) return
    const detailSpaceId = getTrackerTaskSpaceId(task.space_id, spaceId)
    openResourceTab(effectiveTabScopeKey, {
      type: 'tabtracker',
      id: task.id,
      title: task.name,
      meta: { spaceId: detailSpaceId, taskId: task.id },
    })
  }

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertCircle className="h-6 w-6 text-destructive/80" />
        <p className="text-body text-foreground/80">{t('list.loadError', '加载失败')}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => organizationId && spaceId && loadTasks(organizationId, trackerListSpaceId, undefined, { force: true })}
        >
          {t('list.retry', '重试')}
        </Button>
      </div>
    )
  }

  if (isLoading && tasks.length === 0) {
    return (
      <div className="py-2">
        <DetailedRowListSkeleton />
      </div>
    )
  }

  if (tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Layers className="h-6 w-6 text-muted-foreground/40" />
        <p className="text-body text-muted-foreground/60">
          {t('kanban.empty', '暂无自动化')}
        </p>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full" scrollBar="both">
      <div className="flex h-full min-w-max gap-3 py-2">
        {KANBAN_COLUMNS.map(col => {
          const colTasks = buckets[col.key] ?? []
          const Icon = col.icon
          return (
            <div
              key={col.key}
              className="flex h-full w-64 shrink-0 flex-col rounded-interactive bg-foreground/[0.025] dark:bg-foreground/[0.04]"
            >
              <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
                <Icon className={cn('h-3.5 w-3.5', col.accent)} aria-hidden />
                <span className="text-body font-medium text-foreground/90">
                  {t(col.labelKey, col.defaultLabel)}
                </span>
                <span className={cn('ml-auto', 'tabular-nums', CANVAS_TEXT_META)}>
                  {colTasks.length}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto px-1.5 py-1.5">
                {colTasks.length === 0 ? (
                  <div className={cn('px-2', 'py-3', 'text-muted-foreground/40', CANVAS_TEXT_META)}>
                    {t('kanban.colEmpty', '空')}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {colTasks.map(task => {
                      return (
                        <button
                          key={task.id}
                          type="button"
                          onClick={() => handleOpenDetail(task)}
                          className={cn(
                            'group flex w-full flex-col gap-1 rounded-interactive px-2.5 py-2 text-left',
                            'bg-foreground/[0.025] transition-colors hover:bg-foreground/[0.03] dark:bg-foreground/[0.04] dark:hover:bg-foreground/[0.05]',
                          )}
                        >
                          <span className="flex items-start gap-1.5">
                            <span className="line-clamp-2 min-w-0 flex-1 text-body text-foreground/90">
                              {task.name || t('list.untitled', '未命名')}
                            </span>
                            <TrackerSpaceBadge
                              resourceScope={resourceScope}
                              currentSpaceId={spaceId}
                              taskSpaceId={task.space_id}
                              spaceName={task.space_name}
                            />
                          </span>
                          <div className={cn('flex', 'items-center', 'gap-1.5', CANVAS_TEXT_META)}>
                            <span aria-hidden>
                              {TRIGGER_BADGE[task.trigger_type] ?? '·'}
                            </span>
                            <span className="truncate">{task.trigger_type}</span>
                            {task.total_runs > 0 && (
                              <span className="ml-auto tabular-nums">
                                {task.success_runs}/{task.total_runs}
                              </span>
                            )}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
