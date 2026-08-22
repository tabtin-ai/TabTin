/**
 * TrackerListView — Tracker 模块按时间分组的列表视图（charter v1.8 §3.2）。
 *
 * 同一份 useTrackerStore 数据,按时间维度（next_run_at / last_run_at）渲染：
 *   Today / Tomorrow / This Week / Later / No Schedule。
 *
 * 波次 4 Stage 2.5 一刀切：原文件名 ``TrackerAgendaView.tsx`` 改为
 * ``TrackerListView.tsx``（与 ``TrackerTaskList`` 表格视图并列；视图模式
 * ``viewMode='agenda'`` 保留作为用户感知的视图开关 token）。
 */

import React, { useEffect, useMemo } from 'react'
import { Calendar, Clock, AlertCircle } from 'lucide-react'
import { ScrollArea, Button } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useTrackerListState, useTrackerStore } from '@/stores/useTrackerStore'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import type { TrackerTask } from '@/services/trackerApi'
import { getDisplayableNextRunAt } from '@/services/trackerApi'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import type { ResourceScope } from '@stores/useSpaceViewPrefsStore'
import { getTrackerListSpaceId, getTrackerTaskSpaceId } from './trackerScope'
import { TrackerSpaceBadge } from './TrackerSpaceBadge'

// D2 默认 draft：draft 用 blue 与 TrackerDetail StatusBadge / TrackerOverview
// 草稿胶囊对齐（PRD v2 §5.3.1）—— 与 disabled（muted-foreground/20）拉开视觉
// 距离。与 TrackerTaskList.STATUS_DOT 保持一致。
const STATUS_DOT: Record<string, string> = {
  draft: 'bg-blue-500/80',
  active: 'bg-green-500',
  paused: 'bg-yellow-500',
  disabled: 'bg-muted-foreground/20',
}

interface AgendaGroup {
  key: 'today' | 'tomorrow' | 'thisWeek' | 'later' | 'noSchedule'
  labelKey: string
  defaultLabel: string
  tasks: TrackerTask[]
}

function pickAgendaTime(t: TrackerTask): string | null {
  // 统一走 ``getDisplayableNextRunAt`` helper：只有 active 状态展示 next_run_at；
  // 其他状态（draft/paused/disabled）后端不会调度（scan_due_trackers 等 hardcode
  // status='active'），渲染 next_run_at 会让用户误以为也会按时跑。
  // ``last_run_at`` 是历史事实，任何状态都可展示，作为 fallback。
  return getDisplayableNextRunAt(t) ?? t.last_run_at
}

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function groupAgenda(tasks: TrackerTask[]): AgendaGroup[] {
  const today = startOfDay(new Date())
  const tomorrow = new Date(today.getTime() + 86_400_000)
  const dayAfterTomorrow = new Date(today.getTime() + 2 * 86_400_000)
  const weekEnd = new Date(today.getTime() + 7 * 86_400_000)

  const groups: Record<AgendaGroup['key'], TrackerTask[]> = {
    today: [],
    tomorrow: [],
    thisWeek: [],
    later: [],
    noSchedule: [],
  }

  for (const task of tasks) {
    const iso = pickAgendaTime(task)
    if (!iso) {
      groups.noSchedule.push(task)
      continue
    }
    const t = new Date(iso)
    if (Number.isNaN(t.getTime())) {
      groups.noSchedule.push(task)
      continue
    }
    if (t < tomorrow) groups.today.push(task)
    else if (t < dayAfterTomorrow) groups.tomorrow.push(task)
    else if (t < weekEnd) groups.thisWeek.push(task)
    else groups.later.push(task)
  }

  // 各组内部按时间升序
  const sortByTime = (a: TrackerTask, b: TrackerTask) => {
    const ta = pickAgendaTime(a)
    const tb = pickAgendaTime(b)
    if (!ta && !tb) return 0
    if (!ta) return 1
    if (!tb) return -1
    return new Date(ta).getTime() - new Date(tb).getTime()
  }
  for (const k of Object.keys(groups) as AgendaGroup['key'][]) {
    groups[k].sort(sortByTime)
  }

  // labelKey 用 `timeline.*` 子区块（PRD v2 §5.3）：与 viewAgenda → "时间线" 文案对齐，
  // 避免用户感知层残留"日程/agenda"语义；底层 `viewMode='agenda'` token 是 store 字段保留。
  const out: AgendaGroup[] = [
    { key: 'today', labelKey: 'timeline.today', defaultLabel: '今天', tasks: groups.today },
    { key: 'tomorrow', labelKey: 'timeline.tomorrow', defaultLabel: '明天', tasks: groups.tomorrow },
    { key: 'thisWeek', labelKey: 'timeline.thisWeek', defaultLabel: '本周', tasks: groups.thisWeek },
    { key: 'later', labelKey: 'timeline.later', defaultLabel: '更晚', tasks: groups.later },
    { key: 'noSchedule', labelKey: 'timeline.noSchedule', defaultLabel: '未排期', tasks: groups.noSchedule },
  ]
  return out.filter(g => g.tasks.length > 0)
}

function formatScheduleTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d)
  } catch {
    return '—'
  }
}

interface TrackerListViewProps {
  spaceId: string
  tabScopeKey?: string
  resourceScope?: ResourceScope
}

/**
 * Wave 5 (charter v1.8 §3.2)：Agenda 视图组件 — 按时间维度渲染同一份 Tracker 数据。
 * AgendaView marker for grep validation: charter v1.8 三视图（list / agenda / kanban）。
 */
export const TrackerListView: React.FC<TrackerListViewProps> = ({ spaceId, tabScopeKey, resourceScope = 'space' }) => {
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

  const groups = useMemo(() => groupAgenda(tasks), [tasks])

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
        <Calendar className="h-6 w-6 text-muted-foreground/40" />
        <p className="text-body text-muted-foreground/60">
          {t('timeline.empty', '暂无计划中的自动化')}
        </p>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="py-2">
        {groups.map(group => (
          <div key={group.key} className="mb-3">
            <div className={cn('px-1', 'py-1', 'font-medium', 'uppercase', 'tracking-wider', 'text-muted-foreground/60', CANVAS_TEXT_META)}>
              {t(group.labelKey, group.defaultLabel)}
              <span className="ml-1.5 text-muted-foreground/40">({group.tasks.length})</span>
            </div>
            <div className="space-y-1">
              {group.tasks.map(task => {
                const time = pickAgendaTime(task)
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => handleOpenDetail(task)}
                    className={cn(
                      'group flex w-full items-center gap-2.5 rounded-interactive px-2.5 py-1.5 text-left',
                      'transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                    )}
                  >
                    <span
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full',
                        STATUS_DOT[task.status] ?? STATUS_DOT.draft,
                      )}
                      aria-hidden
                    />
                    <span className="flex-1 truncate text-body text-foreground/90">
                      {task.name || t('list.untitled', '未命名')}
                    </span>
                    <TrackerSpaceBadge
                      resourceScope={resourceScope}
                      currentSpaceId={spaceId}
                      taskSpaceId={task.space_id}
                      spaceName={task.space_name}
                    />
                    <span className={cn('flex', 'shrink-0', 'items-center', 'gap-1', 'tabular-nums', CANVAS_TEXT_META)}>
                      <Clock className="h-3 w-3" />
                      {formatScheduleTime(time)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
