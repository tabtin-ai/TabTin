import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { Plus, AlertCircle } from 'lucide-react'
import { Button, ScrollArea, toast } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { useTrackerListState, useTrackerStore } from '@/stores/useTrackerStore'
import { onResourceEvent } from '@/stores/useUnifiedResources'
import type { HomeSectionHandler, HomeSectionProps } from '../types'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import type { TrackerTask } from '@/services/trackerApi'
import { getDisplayableNextRunAt } from '@/services/trackerApi'
import {
  SIDEBAR_ICON,
  SIDEBAR_LIST_PANEL,
  SIDEBAR_LINK_ACTION,
  SIDEBAR_META_END,
  SIDEBAR_ROW,
  SIDEBAR_ROW_FULL_WIDTH,
  SIDEBAR_ROW_INACTIVE,
} from '@components/layout/sidebarUi'
import { cn } from '@utils/cn'
import { ContextPageHeader } from '../../ContextPageHeader'
import { SidebarTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { getEffectiveScopeForResourceType } from '../../resourceScope'
import { getTrackerListSpaceId, getTrackerTaskSpaceId, TRACKER_RESOURCE_TYPE } from '../../../tabtracker/trackerScope'
import { TrackerSpaceBadge } from '../../../tabtracker/TrackerSpaceBadge'

const HOME_PREVIEW_MAX = 5

const STATUS_EMOJI: Record<string, string> = {
  active: '🟢',
  paused: '🟡',
  draft: '⚪',
  disabled: '🔴',
}

function sortKey(t: TrackerTask): number {
  // 统一走 ``getDisplayableNextRunAt`` helper：只有 active 状态才把 next_run_at
  // 当排序键——draft/paused/disabled 的 next_run_at 不会被后端调度（与
  // TrackerListView / Overview 等同口径）。
  const iso = getDisplayableNextRunAt(t) ?? t.last_run_at ?? t.created_at
  if (!iso) return 0
  const n = new Date(iso).getTime()
  return Number.isNaN(n) ? 0 : n
}

function formatTimeLine(task: TrackerTask, t: (k: string) => string): string {
  // 统一走 ``getDisplayableNextRunAt`` helper——只有 active 状态展示 next_run_at；
  // 其他状态（draft/paused/disabled）后端不会调度，渲染会误导用户以为"下次执行"
  // 快到了。last_run_at 是历史事实，任何状态都展示。
  const nextForDisplay = getDisplayableNextRunAt(task)
  const iso = nextForDisplay ?? task.last_run_at
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    const formatted = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(d)
    return nextForDisplay ? `${t('home.nextRun')}: ${formatted}` : formatted
  } catch {
    return '—'
  }
}

const TabTrackerSection: React.FC<HomeSectionProps> = ({ spaceId, tabScopeKey }) => {
  const { t } = useTranslation('tabtracker')
  const organizationId = useResolvedOrganizationId()
  // 直接订阅 org 级 prefs，与 TrackerPanel 同口径，避免筛选变更不触发重渲染。
  const resourceScope = useSpaceViewPrefsStore(s => {
    const orgKey = organizationId ? `organization:${organizationId}` : null
    if (orgKey) {
      const orgScope = s.prefsBySpace[orgKey]?.resourceScope
      if (orgScope) return orgScope
    }
    return s.prefsBySpace[spaceId]?.resourceScope ?? 'organization'
  })
  const effectiveResourceScope = getEffectiveScopeForResourceType(resourceScope, TRACKER_RESOURCE_TYPE)
  const trackerListSpaceId = getTrackerListSpaceId(spaceId, effectiveResourceScope)

  const trackerList = useTrackerListState(organizationId, trackerListSpaceId)
  const { tasks, isLoading, loadError } = trackerList
  const { loadTasks, setDialogState } = useTrackerStore.getState()

  useEffect(() => {
    if (organizationId) {
      void loadTasks(organizationId, trackerListSpaceId)
    }
  }, [organizationId, trackerListSpaceId, loadTasks])

  const reloadTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const reloadTracker = useCallback(() => {
    if (!organizationId || !spaceId) return
    clearTimeout(reloadTimerRef.current)
    reloadTimerRef.current = setTimeout(() => {
      void loadTasks(organizationId, trackerListSpaceId)
    }, 600)
  }, [organizationId, spaceId, trackerListSpaceId, loadTasks])

  useEffect(() => {
    const eventSpaceId = effectiveResourceScope === 'organization' ? undefined : spaceId
    const unsub = onResourceEvent('tabtracker', reloadTracker, { spaceId: eventSpaceId })
    return () => {
      unsub()
      clearTimeout(reloadTimerRef.current)
    }
  }, [reloadTracker, spaceId, effectiveResourceScope])

  const recent = useMemo(() => {
    return [...tasks].sort((a, b) => sortKey(b) - sortKey(a)).slice(0, HOME_PREVIEW_MAX)
  }, [tasks])

  const hiddenCount = Math.max(tasks.length - recent.length, 0)
  const effectiveTabScopeKey = tabScopeKey ?? resolveForegroundTabScopeKey(spaceId)

  const openTrackerPanel = () => {
    try {
      useSpaceContextTabsStore.getState().openResourceTab(effectiveTabScopeKey, {
        type: 'tabtracker',
        id: `tracker-${spaceId}`,
        title: t('appName'),
        meta: { spaceId },
      })
    } catch (error) {
      console.error('[TabTrackerSection] open failed:', error)
      toast.error(t('toast.error'))
    }
  }

  const openCreate = () => {
    openTrackerPanel()
    setDialogState({ open: true, createSpaceId: spaceId })
  }

  const openTaskDetail = (task: TrackerTask) => {
    try {
      const detailSpaceId = getTrackerTaskSpaceId(task.space_id, spaceId)
      useSpaceContextTabsStore.getState().openResourceTab(effectiveTabScopeKey, {
        type: 'tabtracker',
        id: task.id,
        title: task.name,
        meta: { spaceId: detailSpaceId, taskId: task.id },
      })
    } catch (error) {
      console.error('[TabTrackerSection] open detail failed:', error)
      toast.error(t('toast.error'))
    }
  }

  const pageHeader = (
    <ContextPageHeader
      className="px-1 pt-3"
      icon={<SidebarTypeEmoji appIdOrType="tabtracker" className="h-10 w-10" />}
      iconSurface="none"
      title={t('appName')}
      description={t('home.subtitle', { defaultValue: '创建和管理让 Agent 按计划运行的自动化任务' })}
    />
  )

  if (isLoading && tasks.length === 0) {
    return (
      <div className="min-w-0 w-full space-y-3">
        {pageHeader}
        <DetailedRowListSkeleton count={4} showPreview={false} compact />
      </div>
    )
  }

  if (loadError && tasks.length === 0) {
    return (
      <div className="min-w-0 w-full space-y-3">
        {pageHeader}
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <AlertCircle className="h-8 w-8 text-destructive/60" />
          <p className="text-body text-muted-foreground">{t('home.loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={reloadTracker}>
            {t('detail.retry')}
          </Button>
        </div>
      </div>
    )
  }

  if (tasks.length === 0) {
    return (
      <div className="min-w-0 w-full space-y-3">
        {pageHeader}
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <span className="text-heading leading-none text-muted-foreground/20" aria-hidden>🎯</span>
          <p className="text-body text-muted-foreground">{t('panel.emptyDescription')}</p>
          <Button variant="outline" size="sm" className="mt-1" onClick={openCreate}>
            <Plus className="h-3 w-3" />
            {t('home.create')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3">
      {pageHeader}
      <div className="flex items-center justify-end px-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(SIDEBAR_LINK_ACTION, 'h-auto shrink-0 font-normal')}
          onClick={openTrackerPanel}
        >
          {t('home.viewAll')}
          {hiddenCount > 0 ? ` (+${hiddenCount})` : ''}
        </Button>
      </div>

      <ScrollArea className={cn(SIDEBAR_LIST_PANEL, 'h-full w-full [&>[data-radix-scroll-area-viewport]>div]:!block')}>
        <div className="flex min-h-full min-w-0 w-full flex-col gap-0.5">
          {recent.map(task => {
            return (
              <Button
                key={task.id}
                type="button"
                variant="ghost"
                size="sm"
                className={cn(SIDEBAR_ROW, SIDEBAR_ROW_FULL_WIDTH, SIDEBAR_ROW_INACTIVE)}
                onClick={() => openTaskDetail(task)}
              >
                <span className={cn(SIDEBAR_ICON, 'flex items-center justify-center text-body leading-none')} aria-hidden>
                  {STATUS_EMOJI[task.status] || '⚪'}
                </span>
                <span className="min-w-0 flex-1 truncate text-body text-foreground">{task.name}</span>
                <TrackerSpaceBadge
                  resourceScope={effectiveResourceScope}
                  currentSpaceId={spaceId}
                  taskSpaceId={task.space_id}
                  spaceName={task.space_name}
                />
                <span className={SIDEBAR_META_END}>
                  {formatTimeLine(task, t)}
                </span>
              </Button>
            )
          })}
        </div>
      </ScrollArea>

      <div className="flex items-center justify-between px-1">
        <Button variant="ghost" size="sm" onClick={openCreate}>
          <Plus className="h-[1em] w-[1em]" />
          {t('home.create')}
        </Button>
      </div>
    </div>
  )
}

export const tabtrackerHomeSection: HomeSectionHandler = {
  appId: 'tabtracker',
  labelKey: 'home.assetBrowser.tracker',
  Component: TabTrackerSection,
}
