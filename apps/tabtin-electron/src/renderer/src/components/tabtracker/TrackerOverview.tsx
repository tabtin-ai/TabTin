import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Play,
  Zap,
} from 'lucide-react'
import { Button, toast } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { formatDistanceToNow } from 'date-fns'
import { zhCN, enUS } from 'date-fns/locale'
import * as trackerApi from '@/services/trackerApi'
import { invalidateTrackerAfterTrigger } from '@/services/invalidateTrackerAfterTrigger'
import { useTrackerListState, useTrackerStore } from '@/stores/useTrackerStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import type { TrackerTask } from '@/services/trackerApi'
import i18n from '@/i18n'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import type { ResourceScope } from '@stores/useSpaceViewPrefsStore'
import { getTrackerListSpaceId, getTrackerTaskSpaceId } from './trackerScope'
import { TrackerSpaceBadge } from './TrackerSpaceBadge'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'

function getDateLocale() {
  return i18n.language.startsWith('zh') ? zhCN : enUS
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: getDateLocale() })
  } catch {
    return '—'
  }
}

const TRIGGER_BADGES: Record<string, string> = {
  cron: '⏰',
  interval: '🔄',
  manual: '👆',
  webhook: '🔗',
  table_event: '📊',
  extension_event: '⚡',
}

function isNeedsAttention(t: TrackerTask): boolean {
  if (t.status === 'disabled') return true
  if (t.status === 'active' && t.fail_runs > 0 && t.last_run_at) {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    return new Date(t.last_run_at).getTime() > sevenDaysAgo && t.fail_runs > t.success_runs
  }
  return false
}

function isRunning(t: TrackerTask): boolean {
  return t.status === 'active' && t.has_active_run === true
}

function isScheduled(t: TrackerTask): boolean {
  return t.status === 'active'
}

function isDormant(t: TrackerTask): boolean {
  return t.status === 'draft' || t.status === 'paused'
}

interface SectionProps {
  title: string
  color: string
  children: React.ReactNode
  defaultOpen?: boolean
  count: number
}

const OverviewSection: React.FC<SectionProps> = ({ title, color, children, defaultOpen = true, count }) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="flex flex-col">
      <button
        type="button"
        className={cn('flex', 'items-center', 'gap-1.5', 'px-1', 'py-1', 'font-medium', 'transition-colors', 'hover:text-foreground', CANVAS_TEXT_META)}
        onClick={() => setOpen(x => !x)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span className={cn('h-2 w-2 rounded-full', color)} />
        <span>{title}</span>
        {count > 0 && <span className="text-muted-foreground/60">({count})</span>}
      </button>
      {open && <div className="flex flex-col gap-0.5 pl-1">{children}</div>}
    </section>
  )
}

export interface TrackerOverviewProps {
  spaceId: string
  tabScopeKey?: string
  resourceScope?: ResourceScope
}

export const TrackerOverview: React.FC<TrackerOverviewProps> = ({ spaceId, tabScopeKey, resourceScope = 'space' }) => {
  const { t } = useTranslation('tabtracker')
  const organizationId = useResolvedOrganizationId()
  const trackerListSpaceId = getTrackerListSpaceId(spaceId, resourceScope)
  const loadTasks = useTrackerStore.getState().loadTasks
  const { tasks } = useTrackerListState(organizationId, trackerListSpaceId)
  const effectiveTabScopeKey = tabScopeKey ?? resolveForegroundTabScopeKey(spaceId)

  useEffect(() => {
    if (!organizationId || !spaceId) return
    void loadTasks(organizationId, trackerListSpaceId)
  }, [organizationId, spaceId, trackerListSpaceId, loadTasks])

  const { attention, running, scheduled, dormant } = useMemo(() => {
    const attn: TrackerTask[] = []
    const run: TrackerTask[] = []
    const sched: TrackerTask[] = []
    const dorm: TrackerTask[] = []

    for (const task of tasks) {
      if (isNeedsAttention(task)) { attn.push(task); continue }
      if (isRunning(task)) { run.push(task); continue }
      if (isDormant(task)) { dorm.push(task); continue }
      if (isScheduled(task)) { sched.push(task) }
    }

    sched.sort((a, b) => {
      // 统一走 getDisplayableNextRunAt helper（只有 active 才有 next_run_at），
      // 与其他视图口径一致——即便 isScheduled 未来放宽到含 paused，也不会泄漏 next_run_at。
      const aIso = trackerApi.getDisplayableNextRunAt(a)
      const bIso = trackerApi.getDisplayableNextRunAt(b)
      const ta = aIso ? new Date(aIso).getTime() : Infinity
      const tb = bIso ? new Date(bIso).getTime() : Infinity
      return ta - tb
    })

    return { attention: attn, running: run, scheduled: sched, dormant: dorm }
  }, [tasks])

  const openDetail = (task: TrackerTask) => {
    const detailSpaceId = getTrackerTaskSpaceId(task.space_id, spaceId)
    useSpaceContextTabsStore.getState().openResourceTab(effectiveTabScopeKey, {
      type: 'tabtracker',
      id: task.id,
      title: task.name,
      meta: { spaceId: detailSpaceId, taskId: task.id },
    })
  }

  const renderCrossSpaceBadge = (task: TrackerTask) => (
    <TrackerSpaceBadge
      resourceScope={resourceScope}
      currentSpaceId={spaceId}
      taskSpaceId={task.space_id}
      spaceName={task.space_name}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto py-2">
      {tasks.length > 0 && (
        <p className={cn('px-1', CANVAS_TEXT_META)}>
          {t('overview.summary', { total: tasks.length, attention: attention.length, active: running.length })}
        </p>
      )}

      {/* 需要关注 */}
      {tasks.length > 0 && (
        <OverviewSection title={t('overview.attention')} color={attention.length > 0 ? 'bg-red-500' : 'bg-emerald-500'} count={attention.length}>
          {attention.length === 0 ? (
            <div className="flex items-center gap-2 px-2 py-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500/80" />
              <span className={cn(CANVAS_TEXT_MICRO, 'text-emerald-600 dark:text-emerald-400')}>{t('overview.attentionEmpty')}</span>
            </div>
          ) : (
            attention.map(task => (
              <div
                key={task.id}
                className="flex items-center gap-2 rounded-interactive px-2 py-1.5 transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500/80" />
                <span className="min-w-0 flex-1 truncate text-body text-foreground">{task.name}</span>
                {renderCrossSpaceBadge(task)}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 text-body"
                  onClick={() => openDetail(task)}
                >
                  {t('overview.view')}
                </Button>
              </div>
            ))
          )}
        </OverviewSection>
      )}

      {/* 运行中 */}
      <OverviewSection title={t('overview.running')} color="bg-blue-500" count={running.length}>
        {running.length === 0 ? (
          <p className={cn('px-2', 'py-2', 'italic', CANVAS_TEXT_META)}>{t('overview.runningEmpty')}</p>
        ) : (
          running.map(task => (
            <button
              key={task.id}
              type="button"
              className="flex items-center gap-2 rounded-interactive px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]"
              onClick={() => openDetail(task)}
            >
              <Zap className="h-3.5 w-3.5 shrink-0 text-blue-500/80" />
              <span className="min-w-0 flex-1 truncate text-body text-foreground">{task.name}</span>
              {renderCrossSpaceBadge(task)}
              <span className={cn('shrink-0', CANVAS_TEXT_META)}>{relativeTime(task.last_run_at)}</span>
            </button>
          ))
        )}
      </OverviewSection>

      {/* 已排期 */}
      <OverviewSection title={t('overview.scheduled')} color="bg-green-500" count={scheduled.length}>
        {scheduled.length === 0 ? (
          <p className={cn('px-2', 'py-2', 'italic', CANVAS_TEXT_META)}>{t('overview.scheduledEmpty')}</p>
        ) : (
          scheduled.map(task => (
            <div
              key={task.id}
              className="flex items-center gap-2 rounded-interactive px-2 py-1.5 transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => openDetail(task)}
              >
                <span className="shrink-0 text-body leading-none" aria-hidden>
                  {TRIGGER_BADGES[task.trigger_type] || '⚙️'}
                </span>
                <span className="min-w-0 flex-1 truncate text-body text-foreground">{task.name}</span>
                {renderCrossSpaceBadge(task)}
                <span className={cn('shrink-0', 'tabular-nums', CANVAS_TEXT_META)}>
                  {relativeTime(trackerApi.getDisplayableNextRunAt(task))}
                </span>
              </button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 gap-0.5 text-body"
                onClick={(e) => {
                  e.stopPropagation()
                  void handleTriggerInline(task.id)
                }}
              >
                <Zap className="h-3 w-3" />
                {t('overview.runNow')}
              </Button>
            </div>
          ))
        )}
      </OverviewSection>

      {/* 草稿与暂停 */}
      {dormant.length > 0 && (
        <OverviewSection title={t('overview.dormant')} color="bg-muted-foreground/30" count={dormant.length} defaultOpen={false}>
          {dormant.map(task => (
            <div
              key={task.id}
              className="flex items-center gap-2 rounded-interactive px-2 py-1.5 transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => openDetail(task)}
              >
                <span className="min-w-0 flex-1 truncate text-body text-foreground/80">{task.name}</span>
                {renderCrossSpaceBadge(task)}
                <span className={cn(
                  'shrink-0 rounded-full px-1.5 py-0.5 CANVAS_TEXT_META font-medium',
                  // PRD v2 §5.3.1：draft 用 blue 与主视图（TrackerDetail StatusBadge /
                  // TrackerListView dot）对齐；paused 保留 amber。
                  task.status === 'draft'
                    ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                    : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
                )}>
                  {t(`status.${task.status}`)}
                </span>
              </button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 gap-0.5 text-body"
                onClick={(e) => {
                  e.stopPropagation()
                  void handleActivateInline(task.id, task.status)
                }}
              >
                <Play className="h-3 w-3" />
                {task.status === 'paused' ? t('overview.resume') : t('overview.activate')}
              </Button>
            </div>
          ))}
        </OverviewSection>
      )}
    </div>
  )
}

async function handleTriggerInline(taskId: string) {
  try {
    await trackerApi.triggerTask(taskId)
    await invalidateTrackerAfterTrigger(taskId)
  } catch {
    toast.error(i18n.t('toast.error', { ns: 'tabtracker' }))
  }
}

async function handleActivateInline(taskId: string, status: string) {
  try {
    if (status === 'paused') {
      await trackerApi.resumeTask(taskId)
    } else {
      await trackerApi.activateTask(taskId)
    }
    await useTrackerStore.getState().patchTaskFromWS(taskId)
  } catch {
    toast.error(i18n.t('toast.error', { ns: 'tabtracker' }))
  }
}
