import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Plus, Search, X } from 'lucide-react'
import { Button } from '@components/ui'
import { useTrackerStore } from '@/stores/useTrackerStore'
import { PaneLoadingSkeleton } from '@components/common/ListSkeletons'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import {
  useTrackerEventStream,
  type UseTrackerEventStreamOptions,
} from '@/hooks/useTrackerEventStream'
import { useSpaceStore } from '@stores/useSpaceStore'
import { CreateTrackerDialog } from './CreateTrackerDialog'
import { StandaloneModulePage } from '../context-space/StandaloneModulePage'
import {
  toInlineDetailFromTask,
  useTrackerAutomationNavStore,
  type TrackerDetailNavigation,
  type TrackerInlineDetailTarget,
} from './trackerDetailNavigation'
import type { TrackerTask } from '@/services/trackerApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('TrackerPanel')

const LazyListView = React.lazy(() =>
  import('./TrackerTaskList').then(m => ({ default: m.TrackerTaskList })),
)

const LazyTrackerDetail = React.lazy(() =>
  import('./TrackerDetail').then(m => ({ default: m.TrackerDetail })),
)

type TrackerEventSubscriptionProps = Omit<
  UseTrackerEventStreamOptions,
  'spaceId' | 'enabled'
> & {
  spaceId: string
}

/**
 * 一个子组件固定订阅一个 Space topic；父组件按 scope map 出 N 个实例，
 * 避免在循环里直接调用 hook。
 */
const TrackerEventSubscription: React.FC<TrackerEventSubscriptionProps> = props => {
  useTrackerEventStream(props)
  return null
}

export interface TrackerPanelProps {
  spaceId: string
  tabScopeKey?: string
  /**
   * 详情导航宿主：`inline` = 自动化主画布页内详情；`tab` = Agent Context Tab。
   * 默认 `tab`，避免漏传时误走页内路径。
   */
  detailNavigation?: TrackerDetailNavigation
}

export const TrackerPanel: React.FC<TrackerPanelProps> = ({
  spaceId,
  tabScopeKey,
  detailNavigation = 'tab',
}) => {
  const { t } = useTranslation('tabtracker')
  const organizationId = useResolvedOrganizationId()
  const spaces = useSpaceStore(s => s.spaces)
  const dialogState = useTrackerStore(s => s.dialogState)
  const setDialogState = useTrackerStore(s => s.setDialogState)
  const loadTasks = useTrackerStore.getState().loadTasks
  const trackerEventSpaceIds = useMemo(() => {
    if (!organizationId) return [spaceId]
    return spaces
      .filter(space => (
        space.organization_id === organizationId
        && !space.is_archived
        && space.type !== 'team_space'
      ))
      .map(space => space.id)
  }, [organizationId, spaceId, spaces])

  const [inlineDetail, setInlineDetail] = useState<TrackerInlineDetailTarget | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const useInlineDetailNav = detailNavigation === 'inline'
  const automationNavSeq = useTrackerAutomationNavStore(s => s.seq)
  const automationNavDetail = useTrackerAutomationNavStore(s => s.detail)
  const lastAutomationNavSeqRef = useRef(0)

  const handleOpenTaskDetail = useCallback((task: TrackerTask) => {
    const target = toInlineDetailFromTask(task, spaceId)
    setInlineDetail(target)
    useTrackerAutomationNavStore.getState().openDetail(target)
  }, [spaceId])

  const clearInlineDetail = useCallback(() => {
    setInlineDetail(null)
    // 与侧栏 bridge 对齐，避免切走再回来时按旧 seq 重开详情
    useTrackerAutomationNavStore.getState().openList()
  }, [])

  useEffect(() => {
    if (!useInlineDetailNav) return
    if (automationNavSeq === lastAutomationNavSeqRef.current) return
    lastAutomationNavSeqRef.current = automationNavSeq
    setInlineDetail(automationNavDetail)
  }, [useInlineDetailNav, automationNavSeq, automationNavDetail])

  const patchTaskFromWS = useTrackerStore.getState().patchTaskFromWS
  const wsHandleRunTerminal = useCallback(
    (payload: { tracker_id?: string }) => {
      if (!payload.tracker_id) return
      void patchTaskFromWS(payload.tracker_id)
    },
    [patchTaskFromWS],
  )

  const wsHandleReconnected = useCallback(() => {
    if (organizationId && spaceId) {
      void loadTasks(organizationId, undefined, undefined, { force: true })
    }
  }, [organizationId, spaceId, loadTasks])

  const handleCreated = useCallback(() => {
    if (organizationId && spaceId) {
      void loadTasks(organizationId, undefined, undefined, { force: true })
    }
    log.info('tracker created; refresh list')
  }, [organizationId, spaceId, loadTasks])

  useEffect(() => {
    if (!organizationId || !spaceId) return
    void loadTasks(organizationId, undefined)
  }, [organizationId, spaceId, loadTasks])

  const openCreate = useCallback(() => {
    setDialogState({ open: true, createSpaceId: spaceId })
  }, [setDialogState, spaceId])

  useEffect(() => {
    if (!searchOpen) return
    searchInputRef.current?.focus()
  }, [searchOpen])

  if (!spaceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-body text-muted-foreground/60">{t('panel.selectSpace')}</p>
      </div>
    )
  }

  const eventSubscriptions = trackerEventSpaceIds.map((eventSpaceId, index) => (
    <TrackerEventSubscription
      key={eventSpaceId}
      spaceId={eventSpaceId}
      onRunCompleted={wsHandleRunTerminal}
      onRunFailed={wsHandleRunTerminal}
      onReconnected={index === 0 ? wsHandleReconnected : undefined}
    />
  ))

  const listHeaderActions = (
    <div className="flex items-center gap-2">
      {searchOpen || searchQuery ? (
        <div className="relative w-[220px] max-w-[35vw]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" aria-hidden />
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            placeholder={t('panel.search')}
            aria-label={t('panel.search')}
            className="h-9 w-full rounded-md border border-foreground/15 bg-background pl-8 pr-8 text-body text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/45 focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
          />
          <button
            type="button"
            className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground/60 transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setSearchQuery('')
              setSearchOpen(false)
            }}
            aria-label={t('panel.clearSearch', { defaultValue: '关闭搜索' })}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9 rounded-full border-foreground/15 bg-background text-muted-foreground shadow-none hover:bg-foreground/[0.025] hover:text-foreground"
          onClick={() => setSearchOpen(true)}
          aria-label={t('panel.search')}
          title={t('panel.search')}
        >
          <Search className="h-4 w-4" aria-hidden />
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 rounded-md border-foreground/15 bg-background text-foreground shadow-none hover:bg-foreground/[0.025]"
        onClick={openCreate}
        aria-label={t('panel.createAction', { defaultValue: '新建' })}
        title={t('panel.createAction', { defaultValue: '新建' })}
      >
        <Plus className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  )

  if (useInlineDetailNav && inlineDetail) {
    return (
      <>
        {eventSubscriptions}
        <div className="h-full min-h-0" data-testid="tracker-inline-detail-root">
          <Suspense fallback={<PaneLoadingSkeleton />}>
            <LazyTrackerDetail
              spaceId={inlineDetail.spaceId}
              taskId={inlineDetail.taskId}
              onNavigateBack={clearInlineDetail}
            />
          </Suspense>
        </div>
        <CreateTrackerDialog
          open={dialogState.open && (
            dialogState.editTask
              ? true
              : !dialogState.createSpaceId || dialogState.createSpaceId === spaceId
          )}
          onOpenChange={open => {
            setDialogState(open
              ? { open: true, createSpaceId: spaceId, editTask: dialogState.editTask }
              : { open: false })
          }}
          spaceId={dialogState.createSpaceId || spaceId}
          editTracker={dialogState.editTask}
          onCreated={handleCreated}
        />
      </>
    )
  }

  return (
    <>
      {eventSubscriptions}

      <StandaloneModulePage
        icon={<Activity className="h-7 w-7" strokeWidth={1.5} absoluteStrokeWidth aria-hidden />}
        title={t('automation.title', { defaultValue: '自动化' })}
        description={t('automation.subtitle', {
          defaultValue: '用自动化任务让 Agent 按计划自动执行',
        })}
        actions={listHeaderActions}
      >
        <div className="flex h-full min-h-0 flex-col gap-3">
          <div className="min-h-0 flex-1 overflow-hidden">
            <Suspense fallback={<PaneLoadingSkeleton />}>
              <LazyListView
                spaceId={spaceId}
                tabScopeKey={tabScopeKey}
                searchQuery={searchQuery}
                onOpenDetail={useInlineDetailNav ? handleOpenTaskDetail : undefined}
              />
            </Suspense>
          </div>
        </div>
      </StandaloneModulePage>

      <CreateTrackerDialog
        open={dialogState.open && (
          dialogState.editTask
            ? true
            : !dialogState.createSpaceId || dialogState.createSpaceId === spaceId
        )}
        onOpenChange={open => {
          setDialogState(open
            ? { open: true, createSpaceId: spaceId, editTask: dialogState.editTask }
            : { open: false })
        }}
        spaceId={dialogState.createSpaceId || spaceId}
        editTracker={dialogState.editTask}
        onCreated={handleCreated}
      />
    </>
  )
}
