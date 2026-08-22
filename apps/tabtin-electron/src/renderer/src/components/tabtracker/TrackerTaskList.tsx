import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Clock, RefreshCw, Search } from 'lucide-react'
import { AgentApiService } from '@tabtin/app-shell'
import { Button, ScrollArea } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { useTrackerListState, useTrackerStore } from '@/stores/useTrackerStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META } from '@components/layout/canvasUi'
import { getDisplayableNextRunAt, type TrackerTask } from '@/services/trackerApi'
import { createLogger } from '@/utils/logger'
import { TrackerTaskRowActions } from './TrackerTaskRowActions'
import { getTrackerTaskSpaceId } from './trackerScope'
import { revealTrackerWorkbench } from './revealTrackerWorkbench'
import {
  formatAutomationAbsoluteTime,
  isAutomationListTrigger,
  toScheduledAutomationStatus,
} from './scheduledAutomation'
import { describeTriggerFrequency } from './triggerFrequency'

const log = createLogger('TrackerTaskList')

interface AgentNamesState {
  organizationId: string | null
  names: Record<string, string>
  loaded: boolean
}

function instructionSummary(task: TrackerTask): string {
  const fromField = typeof task.instructions === 'string' ? task.instructions.trim() : ''
  if (fromField) return fromField
  const fromParams = task.skill_params?.instructions
  if (typeof fromParams === 'string' && fromParams.trim()) return fromParams.trim()
  return (task.description || '').trim()
}

export interface TrackerTaskListProps {
  spaceId: string
  tabScopeKey?: string
  searchQuery?: string
  /** 自动化独立页传入：页内打开详情，不切 Agent 工作台 */
  onOpenDetail?: (task: TrackerTask) => void
}

export const TrackerTaskList: React.FC<TrackerTaskListProps> = ({
  spaceId,
  tabScopeKey,
  searchQuery = '',
  onOpenDetail,
}) => {
  const { t } = useTranslation('tabtracker')
  const organizationId = useResolvedOrganizationId()
  const loadTasks = useTrackerStore.getState().loadTasks
  const loadMoreTasks = useTrackerStore.getState().loadMoreTasks
  const trackerList = useTrackerListState(organizationId, undefined)
  const { tasks, isLoading, loadError, hasMore } = trackerList

  const [agentNamesState, setAgentNamesState] = useState<AgentNamesState>({
    organizationId: null,
    names: {},
    loaded: false,
  })
  const agentNames = useMemo(
    () => agentNamesState.organizationId === organizationId ? agentNamesState.names : {},
    [agentNamesState, organizationId],
  )
  const agentNamesLoaded = agentNamesState.organizationId === organizationId
    && agentNamesState.loaded

  useEffect(() => {
    if (!organizationId) return
    void loadTasks(organizationId, undefined)
  }, [organizationId, loadTasks])

  useEffect(() => {
    if (!organizationId) {
      setAgentNamesState({ organizationId: null, names: {}, loaded: true })
      return
    }
    let cancelled = false
    setAgentNamesState({ organizationId, names: {}, loaded: false })
    log.debug(`loading automation agent labels organizationId=${organizationId}`)
    void AgentApiService.listAgents(organizationId)
      .then(agents => {
        if (cancelled) return
        setAgentNamesState({
          organizationId,
          names: Object.fromEntries(agents.map(agent => [
            agent.id,
            agent.display_name || agent.name,
          ])),
          loaded: true,
        })
      })
      .catch(error => {
        if (cancelled) return
        log.error(`failed to load automation agent labels organizationId=${organizationId}`, error)
        setAgentNamesState({ organizationId, names: {}, loaded: true })
      })
    return () => {
      cancelled = true
    }
  }, [organizationId])

  const visibleTasks = useMemo(
    () => tasks.filter(task => isAutomationListTrigger(task.trigger_type)),
    [tasks],
  )

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return visibleTasks
    return visibleTasks.filter(task => (
      task.name.toLowerCase().includes(query)
      || (task.description || '').toLowerCase().includes(query)
      || instructionSummary(task).toLowerCase().includes(query)
      || (task.space_name || '').toLowerCase().includes(query)
      || (task.agent_id ? (agentNames[task.agent_id] || '').toLowerCase().includes(query) : false)
    ))
  }, [agentNames, visibleTasks, searchQuery])

  const openDetail = useCallback((task: TrackerTask) => {
    if (onOpenDetail) {
      onOpenDetail(task)
      return
    }
    const detailSpaceId = getTrackerTaskSpaceId(task.space_id, spaceId)
    const targetTabScope = revealTrackerWorkbench(spaceId, tabScopeKey)
    useSpaceContextTabsStore.getState().openResourceTab(targetTabScope, {
      type: 'tabtracker',
      id: task.id,
      title: task.name,
      meta: { spaceId: detailSpaceId, taskId: task.id },
    })
  }, [onOpenDetail, tabScopeKey, spaceId])

  return (
    <div data-testid="tracker-task-list-root" className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1 [&>[data-radix-scroll-area-viewport]>div]:!block [&>[data-radix-scroll-area-viewport]>div]:!w-full [&>[data-radix-scroll-area-viewport]>div]:!min-w-0">
        <div
          data-testid="tracker-task-list-content"
          className="w-full min-w-0 pb-4"
        >
          {isLoading && tasks.length === 0 ? (
            <div className="py-2" aria-busy="true" aria-label={t('detail.loading')}>
              <DetailedRowListSkeleton count={4} compact />
            </div>
          ) : loadError && tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12" role="alert">
              <AlertCircle className="h-8 w-8 text-destructive/60" />
              <p className="text-body text-muted-foreground">{t('home.loadFailed')}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 text-body"
                onClick={() => organizationId && void loadTasks(organizationId, undefined, undefined, { force: true })}
              >
                <RefreshCw className="h-[1em] w-[1em]" />
                {t('detail.retry')}
              </Button>
            </div>
          ) : filtered.length === 0 && searchQuery.trim() ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12" role="status">
              <Search className="h-8 w-8 text-muted-foreground/30" />
              <p className="text-body text-muted-foreground">{t('panel.noResults')}</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16" role="status">
              <Clock className="h-8 w-8 text-muted-foreground/30" aria-hidden />
              <div className="flex flex-col items-center gap-1">
                <p className="text-body font-medium text-foreground/80">{t('panel.emptyTitle')}</p>
                <p className={CANVAS_TEXT_META}>{t('panel.emptyDescription')}</p>
                <p className={cn('mt-1', CANVAS_TEXT_META)}>{t('panel.emptyHint')}</p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div
                className="grid grid-cols-[repeat(auto-fill,minmax(min(480px,100%),1fr))] gap-3"
                role="list"
              >
                {filtered.map(task => {
                  const summary = instructionSummary(task)
                  const workspaceLabel = (task.space_name ?? '').trim() || t('panel.workspaceUnavailable')
                  const isAgentLabelLoading = Boolean(task.agent_id) && !agentNamesLoaded
                  const agentLabel = task.agent_id
                    ? agentNames[task.agent_id] || t('panel.agentUnavailable')
                    : t('panel.agentUnavailable')
                  const normalizedStatus = toScheduledAutomationStatus(task.status)
                  const frequencyInfo = describeTriggerFrequency(task.trigger_type, task.trigger_config, t)
                  const nextRunAt = getDisplayableNextRunAt(task)
                  const cronExpression = task.trigger_type === 'cron'
                    && typeof task.trigger_config?.cron_expression === 'string'
                    ? task.trigger_config.cron_expression.trim()
                    : ''
                  const scheduleLabel = task.trigger_type === 'cron' && !cronExpression && nextRunAt
                    ? t('panel.nextRunAt', { time: formatAutomationAbsoluteTime(nextRunAt) })
                    : frequencyInfo.summary || t('panel.noNextRun')

                  return (
                    <article
                      key={task.id}
                      role="listitem"
                      data-testid={`tracker-task-row-${task.id}`}
                      className="overflow-hidden rounded-[10px] border border-foreground/10 bg-background transition-[border-color,background-color] hover:border-foreground/20 hover:bg-foreground/[0.01] dark:hover:bg-foreground/[0.02]"
                    >
                      <div className="flex min-w-0 items-start">
                        <button
                          type="button"
                          className="block min-w-0 flex-1 px-4 pb-2.5 pt-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          onClick={() => openDetail(task)}
                          aria-label={t('panel.openTaskDetail', { name: task.name })}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <span className="min-w-0 truncate text-subtitle font-semibold text-foreground" title={task.name}>
                              {task.name}
                            </span>
                            <span className="inline-flex h-[22px] max-w-full shrink-0 items-center rounded-md bg-foreground/[0.045] px-2 text-caption text-muted-foreground/80">
                              <span className="max-w-[220px] truncate" title={workspaceLabel}>{workspaceLabel}</span>
                            </span>
                          </span>

                          <span
                            className={cn(
                              'mt-1 block min-w-0 whitespace-pre-wrap break-words text-body leading-relaxed',
                              summary ? 'line-clamp-1 text-muted-foreground' : 'italic text-muted-foreground/60',
                            )}
                            title={summary || undefined}
                          >
                            {summary || t('detail.noInstructions')}
                          </span>
                        </button>

                        <TrackerTaskRowActions
                          task={task}
                          className="shrink-0 px-3 py-2.5"
                        />
                      </div>

                      <div className="flex min-h-10 min-w-0 items-center gap-2.5 border-t border-foreground/[0.07] px-4 py-2">
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground/80">
                          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                          <span className="truncate tabular-nums" title={scheduleLabel}>{scheduleLabel}</span>
                        </span>
                        {normalizedStatus === 'paused' ? (
                          <span className="inline-flex h-[22px] shrink-0 items-center rounded-md bg-foreground/[0.06] px-2 text-caption font-medium text-muted-foreground">
                            {t('status.paused')}
                          </span>
                        ) : null}
                        {isAgentLabelLoading ? (
                          <span
                            aria-hidden
                            data-testid={`tracker-agent-label-loading-${task.id}`}
                            className="ml-auto inline-flex h-[22px] w-14 shrink-0 rounded-md bg-foreground/[0.045]"
                          />
                        ) : (
                          <span className="ml-auto inline-flex h-[22px] max-w-[220px] shrink-0 items-center rounded-md bg-foreground/[0.045] px-2 text-caption text-muted-foreground/80">
                            <span className="truncate" title={agentLabel}>{agentLabel}</span>
                          </span>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>

              {hasMore && !searchQuery.trim() ? (
                <div className="flex justify-center py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-body text-muted-foreground"
                    disabled={isLoading}
                    onClick={() => organizationId && void loadMoreTasks(organizationId, undefined)}
                  >
                    {isLoading ? <RefreshCw className="h-[1em] w-[1em] animate-spin" /> : null}
                    {t('panel.loadMore')}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
