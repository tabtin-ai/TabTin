import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  Pencil,
  ShieldCheck,
  Zap,
} from 'lucide-react'
import { AgentApiService } from '@tabtin/app-shell'
import {
  Button,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  toast,
} from '@components/ui'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META, CANVAS_TEXT_META_BASE } from '@components/layout/canvasUi'
import { useTranslation } from 'react-i18next'
import * as trackerApi from '@/services/trackerApi'
import type { TaskDetail, TaskRun } from '@/services/trackerApi'
import { getDisplayableNextRunAt } from '@/services/trackerApi'
import { invalidateTrackerAfterTrigger } from '@/services/invalidateTrackerAfterTrigger'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import {
  useTrackerEventStream,
  type TrackerChangePayload,
} from '@/hooks/useTrackerEventStream'
import type {
  TrackerProgressEvent,
  TrackerRunCompletedEvent,
  TrackerRunCancelledEvent,
  TrackerRunFailedEvent,
} from '@/hooks/tracker-ws-payload'
import { enterChatSession } from '@/services/chatSessionNavigation'
import { MarkdownRenderer } from '@components/chat/markdown/MarkdownRenderer'
import { ContextListPanelBreadcrumb } from '@components/context-space/ContextListPanelBreadcrumb'
import { describeTriggerFrequency } from './triggerFrequency'
import { CreateTrackerDialog } from './CreateTrackerDialog'
import { TrackerStatusPill } from './trackerStatusUi'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { createLogger } from '@/utils/logger'
import {
  formatAutomationAbsoluteTime,
  formatAutomationRunTime,
  toScheduledAutomationStatus,
} from './scheduledAutomation'

const log = createLogger('TrackerDetail')

export interface TrackerDetailProps {
  spaceId: string
  tabScopeKey?: string
  taskId: string
  /**
   * 自动化独立页内嵌详情时传入：面包屑/删除后返回列表，不写 Context Tab。
   * Agent 工作台路径不传，继续走 openResourceTab / closeTab。
   */
  onNavigateBack?: () => void
}

const RUN_STATUS_CONFIG: Record<string, { color: string }> = {
  completed: {
    color: 'text-success',
  },
  failed: {
    color: 'text-destructive',
  },
  running: {
    color: 'text-info',
  },
  pending: {
    color: 'text-muted-foreground',
  },
  cancelled: {
    color: 'text-muted-foreground',
  },
  // 离线韧性 M1：执行设备离线时 Run 挂起等待，设备上线自动继续（最长 6 小时）。
  waiting_device: {
    color: 'text-warning',
  },
}

function isActiveRunStatus(status: string): boolean {
  return status === 'running' || status === 'pending' || status === 'waiting_device'
}

// 已结束任务仍提示恢复后才会继续执行；执行失败原因已在下方历史记录中直接展示，
// 不再额外重复一条泛化警告。
function getAttentionReason(detail: TaskDetail): 'disabled' | null {
  if (detail.status === 'disabled') return 'disabled'
  return null
}

function getMissedSkipInfo(detail: TaskDetail): { count: number; lastMissedAt: string } | null {
  const config = detail.trigger_config ?? {}
  const count = Number(config._missed_count ?? 0)
  const lastMissedAt = typeof config._last_missed_at === 'string' ? config._last_missed_at : ''
  if (!Number.isFinite(count) || count <= 0 || !lastMissedAt) return null
  if (config.catchup_policy !== 'skip') return null
  return { count, lastMissedAt }
}

function RunItem({
  run,
  t,
  onCancel,
  onOpenSession,
  isCancelling,
}: {
  run: TaskRun
  t: (key: string, opts?: Record<string, unknown>) => string
  onCancel?: (runId: string) => void
  onOpenSession?: (sessionId: string) => void
  isCancelling?: boolean
}) {
  const cfg = RUN_STATUS_CONFIG[run.status] ?? RUN_STATUS_CONFIG.pending
  const canOpenSession = Boolean(run.chat_session_id && onOpenSession)
  const runTimeSource = run.started_at || run.created_at
  const displayTime = formatAutomationRunTime(runTimeSource) || '—'
  const absoluteTime = formatAutomationAbsoluteTime(runTimeSource)
  const secondaryTime = displayTime !== absoluteTime ? absoluteTime : ''
  const handleOpenSession = () => {
    if (!run.chat_session_id) return
    onOpenSession?.(run.chat_session_id)
  }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canOpenSession) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleOpenSession()
    }
  }

  const isFailureLike =
    run.status === 'failed' || run.status === 'cancelled' || run.status === 'partial_failed'
  const errorSummary = run.error_summary?.trim() || ''
  const resultSummary = run.result_summary?.trim() || ''
  const showFailureDetail = isFailureLike && Boolean(errorSummary || resultSummary)
  const showDistinctRawError =
    Boolean(resultSummary) && resultSummary !== errorSummary
  const failureDetailTitle =
    run.status === 'cancelled' ? t('detail.cancelDetail') : t('detail.errorDetail')

  return (
    <div
      data-testid={`tracker-run-item-${run.id}`}
      className={`flex items-start gap-3 px-[18px] py-3.5 transition-colors hover:bg-foreground/[0.025] dark:hover:bg-foreground/[0.04] ${
        canOpenSession
          ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40'
          : ''
      }`}
      role={canOpenSession ? 'button' : undefined}
      tabIndex={canOpenSession ? 0 : undefined}
      title={canOpenSession ? t('detail.openRunSession') : undefined}
      onClick={canOpenSession ? handleOpenSession : undefined}
      onKeyDown={handleKeyDown}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span
            data-testid={`tracker-run-relative-time-${run.id}`}
            className="min-w-0 text-body font-semibold tabular-nums text-foreground"
          >
            {displayTime}
          </span>
          <span
            data-testid={`tracker-run-right-meta-${run.id}`}
            className="ml-auto inline-flex shrink-0 items-center gap-3"
          >
            <span
              data-testid={`tracker-run-status-${run.id}`}
              className={cn('inline-flex min-w-16 items-center justify-end gap-1.5 text-body font-medium', cfg.color)}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
              {t(`detail.runStatus.${run.status}`)}
            </span>
            <span
              data-testid={`tracker-run-chevron-slot-${run.id}`}
              className="grid h-4 w-4 shrink-0 place-items-center"
              aria-hidden
            >
              {canOpenSession ? (
                <ChevronRight
                  data-testid={`tracker-run-chevron-${run.id}`}
                  className="h-4 w-4 text-muted-foreground/60"
                />
              ) : null}
            </span>
          </span>
        </div>
        <div className={cn('mt-1', 'flex', 'flex-wrap', 'gap-x-3', 'gap-y-0.5', CANVAS_TEXT_META)}>
          {secondaryTime ? <span className="tabular-nums">{secondaryTime}</span> : null}
          {run.progress_pct > 0 && run.status === 'running' && (
            <span>{Math.round(run.progress_pct)}%</span>
          )}
        </div>
        {run.progress_message && (run.status === 'running' || run.status === 'waiting_device') && (
          <p className={cn('mt-1', 'line-clamp-1', CANVAS_TEXT_META)}>
            {run.progress_message}
          </p>
        )}
        {run.status === 'completed' && resultSummary && (
          <details
            className="group mt-1"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <summary className={cn('cursor-pointer', 'hover:text-foreground/80', 'transition-colors', CANVAS_TEXT_META)}>
              {t('detail.resultSummary')}
            </summary>
            <div className="mt-1 rounded-interactive bg-foreground/[0.03] p-2 dark:bg-foreground/[0.04]">
              <MarkdownRenderer
                content={resultSummary}
                lightweight
                renderLevel={2}
                className="text-body leading-relaxed text-foreground/80 [&_p]:my-0 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5"
              />
            </div>
          </details>
        )}
        {showFailureDetail && (
          <details
            className="group mt-1"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <summary className={cn('cursor-pointer', 'text-destructive/80', 'hover:text-destructive', 'transition-colors', CANVAS_TEXT_META_BASE)}>
              {failureDetailTitle}
            </summary>
            <div className="mt-1 space-y-2 rounded-interactive bg-foreground/[0.03] p-2 dark:bg-foreground/[0.04]">
              {errorSummary ? (
                <p className="text-body leading-relaxed text-destructive/90 whitespace-pre-wrap">
                  {errorSummary}
                </p>
              ) : null}
              {showDistinctRawError ? (
                <MarkdownRenderer
                  content={resultSummary}
                  lightweight
                  renderLevel={2}
                  className="text-body leading-relaxed text-foreground/80 [&_p]:my-0 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5"
                />
              ) : null}
            </div>
          </details>
        )}
        {onCancel && isActiveRunStatus(run.status) && (
          <button
            type="button"
            disabled={isCancelling}
            className={cn('mt-1', 'inline-flex', 'items-center', 'gap-1', 'text-destructive/80', 'transition-colors', 'hover:text-destructive', 'disabled:cursor-not-allowed', 'disabled:opacity-60', CANVAS_TEXT_META_BASE)}
            onClick={(event) => {
              event.stopPropagation()
              if (isCancelling) return
              onCancel(run.id)
            }}
          >
            {isCancelling && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('detail.actions.cancelRun')}
          </button>
        )}
      </div>
    </div>
  )
}

export const TrackerDetail: React.FC<TrackerDetailProps> = ({
  spaceId,
  tabScopeKey,
  taskId,
  onNavigateBack,
}) => {
  const { t } = useTranslation('tabtracker')
  const organizationId = useResolvedOrganizationId()
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  const [runs, setRuns] = useState<TaskRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)

  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [cancelRunId, setCancelRunId] = useState<string | null>(null)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [agentName, setAgentName] = useState('')
  const deleteNavigationDoneRef = useRef(false)
  const activeRunRefreshInFlightRef = useRef(false)
  const detailRefreshSequenceRef = useRef(0)
  const refreshSequenceRef = useRef(0)

  const reloadTask = useCallback(() => {
    setReloadToken(x => x + 1)
  }, [])

  useEffect(() => {
    deleteNavigationDoneRef.current = false
    setMoreOpen(false)
  }, [spaceId, taskId])

  useEffect(() => {
    const agentId = detail?.agent_id
    if (!organizationId || !agentId) {
      setAgentName('')
      return
    }
    let cancelled = false
    void AgentApiService.listAgents(organizationId)
      .then(agents => {
        if (cancelled) return
        const agent = agents.find(item => item.id === agentId)
        setAgentName(agent?.display_name || agent?.name || '')
      })
      .catch(error => {
        if (cancelled) return
        log.error(`failed to resolve automation agent taskId=${taskId} agentId=${agentId}`, error)
        setAgentName('')
      })
    return () => {
      cancelled = true
    }
  }, [detail?.agent_id, organizationId, taskId])

  const navigateToList = useCallback(() => {
    if (onNavigateBack) {
      onNavigateBack()
      return
    }
    const tabsStore = useSpaceContextTabsStore.getState()
    const scopeKey = tabScopeKey ?? spaceId
    const trackerHomeId = `tracker-${spaceId}`
    tabsStore.openResourceTab(scopeKey, {
      type: 'tabtracker',
      id: trackerHomeId,
      title: t('appName'),
      meta: { spaceId },
    })
  }, [onNavigateBack, spaceId, tabScopeKey, t])

  const navigateBackToList = useCallback((showToast = true) => {
    deleteNavigationDoneRef.current = true
    if (showToast) {
      toast.info(t('detail.actions.deleted'))
    }
    if (onNavigateBack) {
      onNavigateBack()
      return
    }
    navigateToList()
    const tabsStore = useSpaceContextTabsStore.getState()
    const scopeKey = tabScopeKey ?? spaceId
    const trackerHomeId = `tracker-${spaceId}`
    const trackerHomeTabKey = `tabtracker:${trackerHomeId}`
    const detailTabKey = `tabtracker:${taskId}`

    tabsStore.closeTab(scopeKey, detailTabKey, trackerHomeTabKey)
  }, [onNavigateBack, spaceId, tabScopeKey, taskId, t, navigateToList])

  const renderListBreadcrumb = useCallback((currentLabel: string) => (
    <ContextListPanelBreadcrumb
      className="min-w-0"
      separator={<ChevronRight className="h-3 w-3 text-muted-foreground/30" />}
      items={[
        { id: null, label: t('appName') },
        { id: taskId, label: currentLabel, current: true },
      ]}
      onSelect={(id) => {
        if (id === null) navigateToList()
      }}
    />
  ), [navigateToList, t, taskId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    void (async () => {
      try {
        const d = await trackerApi.getTask(taskId)
        if (!cancelled) {
          setDetail(d)
          setLoading(false)
        }
      } catch (loadError) {
        log.error(`failed to load automation detail taskId=${taskId}`, loadError)
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [taskId, reloadToken])

  const refreshDetail = useCallback(async () => {
    const sequence = ++detailRefreshSequenceRef.current
    try {
      const updated = await trackerApi.getTask(taskId)
      if (sequence === detailRefreshSequenceRef.current) {
        setDetail(updated)
        setError(false)
      }
    } catch (refreshError) {
      // 非首屏刷新不切整页错误态，保留用户当前可见内容。
      log.warn(`automation detail refresh failed taskId=${taskId}`, refreshError)
    }
  }, [taskId])

  const commitDetailUpdate = useCallback((updated: TaskDetail) => {
    // 本页操作返回的 detail 比后台静默刷新更新，提交前让旧 refresh 结果失效。
    detailRefreshSequenceRef.current += 1
    setDetail(updated)
    setError(false)
  }, [])

  const loadRuns = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current
    setRunsLoading(true)
    try {
      const r = await trackerApi.listTaskRuns(taskId)
      if (sequence === refreshSequenceRef.current) {
        setRuns(r)
      }
    } catch (runsError) {
      // Run 列表失败不切整页错误态，详情主体仍可继续操作。
      log.warn(`automation runs refresh failed taskId=${taskId}`, runsError)
    }
    finally {
      if (sequence === refreshSequenceRef.current) {
        setRunsLoading(false)
      }
    }
  }, [taskId])

  const refreshDetailAndRuns = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current
    const [taskResult, runsResult] = await Promise.allSettled([
      trackerApi.getTask(taskId),
      trackerApi.listTaskRuns(taskId),
    ])
    if (sequence !== refreshSequenceRef.current) return
    if (taskResult.status === 'fulfilled') {
      setDetail(taskResult.value)
    } else {
      log.warn(`automation detail refresh failed taskId=${taskId}`, taskResult.reason)
    }
    if (runsResult.status === 'fulfilled') {
      setRuns(runsResult.value)
    } else {
      log.warn(`automation runs refresh failed taskId=${taskId}`, runsResult.reason)
    }
    setRunsLoading(false)
  }, [taskId])

  useEffect(() => {
    void loadRuns()
  }, [loadRuns])

  const wsHandleProgress = useCallback(
    (e: TrackerProgressEvent) => {
      if (e.tracker_id !== taskId) return
      if (e.space_id && e.space_id !== spaceId) return
      void loadRuns()
    },
    [taskId, spaceId, loadRuns],
  )

  const wsHandleRunTerminal = useCallback(
    (e: TrackerRunCompletedEvent | TrackerRunFailedEvent | TrackerRunCancelledEvent) => {
      if (e.tracker_id !== taskId) return
      if (e.space_id && e.space_id !== spaceId) return
      void refreshDetailAndRuns()
    },
    [taskId, spaceId, refreshDetailAndRuns],
  )

  const wsHandleTaskUpdated = useCallback(
    (payload: TrackerChangePayload) => {
      if (payload.tracker_id !== taskId) return
      void refreshDetail()
    },
    [taskId, refreshDetail],
  )

  const wsHandleTaskDeleted = useCallback(
    (payload: TrackerChangePayload) => {
      if (payload.tracker_id !== taskId) return
      if (deleteNavigationDoneRef.current) {
        return
      }
      navigateBackToList()
    },
    [taskId, navigateBackToList],
  )

  const wsHandleReconnected = useCallback(() => {
    void refreshDetailAndRuns()
  }, [refreshDetailAndRuns])

  const hasActiveRun = runs.some(run => isActiveRunStatus(run.status))

  useEffect(() => {
    if (!hasActiveRun) return

    const refreshActiveRuns = async () => {
      if (activeRunRefreshInFlightRef.current) return
      activeRunRefreshInFlightRef.current = true
      try {
        await refreshDetailAndRuns()
      } finally {
        activeRunRefreshInFlightRef.current = false
      }
    }

    const intervalId = window.setInterval(() => {
      void refreshActiveRuns()
    }, 5000)

    return () => window.clearInterval(intervalId)
  }, [hasActiveRun, refreshDetailAndRuns])

  // Module F 决策 3：Tracker WS topic 改成按 Space 分发；详情页只关心自己 Space 的事件。
  useTrackerEventStream({
    spaceId,
    enabled: Boolean(spaceId),
    onProgress: wsHandleProgress,
    onRunCompleted: wsHandleRunTerminal,
    onRunFailed: wsHandleRunTerminal,
    onRunCancelled: wsHandleRunTerminal,
    onTrackerUpdated: wsHandleTaskUpdated,
    onTrackerDeleted: wsHandleTaskDeleted,
    onReconnected: wsHandleReconnected,
  })

  const handleCancelRun = useCallback(async (runId: string) => {
    if (cancelRunId) return
    setCancelRunId(runId)
    try {
      const run = runs.find(item => item.id === runId)
      const sessionId = run?.chat_session_id
      if (sessionId) {
        useChatStore.getState().abortStream(sessionId)
      }
      await trackerApi.cancelTaskRun(taskId, runId)
      if (sessionId) {
        useChatStore.getState().abortStream(sessionId)
      }
      toast.success(t('detail.actions.runCancelled'))
      await refreshDetailAndRuns()
    } catch (err) {
      log.error(`automation run cancellation failed taskId=${taskId} runId=${runId}`, err)
      await refreshDetailAndRuns().catch(refreshError => {
        log.warn(`automation refresh after cancellation failed taskId=${taskId}`, refreshError)
      })
      toast.error(err instanceof Error ? err.message : t('toast.error'))
    } finally {
      setCancelRunId(null)
    }
  }, [cancelRunId, taskId, t, refreshDetailAndRuns, runs])

  const handleOpenRunSession = useCallback((sessionId: string) => {
    void enterChatSession(spaceId, sessionId, {
      verifySessionExists: true,
      sessionFailureMessage: t('detail.openRunSessionFailed'),
      initialScroll: 'first-message',
    })
  }, [spaceId, t])

  const handleAction = useCallback(async (action: 'activate' | 'pause' | 'trigger' | 'resume') => {
    if (action === 'trigger' && hasActiveRun) return
    setActionLoading(action)
    log.info(`automation detail action started taskId=${taskId} action=${action}`)
    try {
      if (action === 'activate') {
        const updated = await trackerApi.activateTask(taskId)
        commitDetailUpdate(updated)
        // Module F 决策 2：激活高频 Tracker 时弹一个 toast 提醒用户"已开始按 X 频率自动跑"，
        // 避免 demo 视频里"每 5 分钟一次"被错配成生产场景导致额度被烧。
        const freq = describeTriggerFrequency(updated.trigger_type, updated.trigger_config, t)
        if (freq.isHighFrequency) {
          toast.success(t('detail.highFrequencyToast', {
            summary: freq.summary,
            defaultValue: '已启用 · {{summary}}',
          }))
        } else {
          toast.success(t('toast.activated'))
        }
      } else if (action === 'resume') {
        const updated = await trackerApi.resumeTask(taskId)
        commitDetailUpdate(updated)
        toast.success(t('detail.actions.resumed'))
      } else if (action === 'pause') {
        const updated = await trackerApi.pauseTask(taskId)
        commitDetailUpdate(updated)
        toast.success(t('detail.actions.paused'))
      } else if (action === 'trigger') {
        await trackerApi.triggerTask(taskId)
        toast.success(t('detail.actions.triggered'))
        setReloadToken(x => x + 1)
        void loadRuns()
        void invalidateTrackerAfterTrigger(taskId)
      }
      log.info(`automation detail action completed taskId=${taskId} action=${action}`)
    } catch (err) {
      log.error(`automation detail action failed taskId=${taskId} action=${action}`, err)
      toast.error(err instanceof Error && err.message ? err.message : t('toast.error'))
    } finally {
      setActionLoading(null)
    }
  }, [taskId, t, loadRuns, commitDetailUpdate, hasActiveRun])

  if (loading) {
    return (
      <div className="flex h-full flex-col p-3">
        <div className="mb-3 px-1">{renderListBreadcrumb(t('detail.loading'))}</div>
        <DetailedRowListSkeleton count={3} compact />
      </div>
    )
  }

  if (error || !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <div className="w-full self-start px-1">{renderListBreadcrumb(t('detail.empty'))}</div>
        <AlertCircle className="h-8 w-8 text-destructive/60" />
        <p className="text-body text-muted-foreground">{t('detail.empty')}</p>
        <Button variant="outline" size="sm" className="text-body" onClick={() => setReloadToken(x => x + 1)}>
          {t('detail.retry')}
        </Button>
      </div>
    )
  }

  const normalizedStatus = toScheduledAutomationStatus(detail.status)
  const isActive = normalizedStatus === 'active'
  const canTriggerManually = detail.status === 'active' || detail.status === 'paused'
  const statusLabel = t(`status.${normalizedStatus}`)
  const frequencyInfo = describeTriggerFrequency(detail.trigger_type, detail.trigger_config, t)

  const nextRunIso = getDisplayableNextRunAt(detail)
  const attentionReason = getAttentionReason(detail)
  const missedSkipInfo = getMissedSkipInfo(detail)

  const instructionsText = (() => {
    const fromField = typeof detail.instructions === 'string' ? detail.instructions.trim() : ''
    if (fromField) return fromField
    const fromParams = detail.skill_params?.instructions
    return typeof fromParams === 'string' ? fromParams.trim() : ''
  })()
  const noteText = (detail.description || '').trim()
  const workspaceLabel = (detail.space_name || '').trim() || t('panel.workspaceUnavailable')
  const resolvedAgentName = agentName || t('panel.agentUnavailable')
  const catchupPolicy = detail.trigger_config?.catchup_policy === 'skip' ? 'skip' : 'run_once'
  const configuredOnceAt = detail.trigger_type === 'at'
    && typeof detail.trigger_config?.at === 'string'
    ? formatAutomationAbsoluteTime(detail.trigger_config.at)
    : ''
  const nextRunLabel = isActive
    ? nextRunIso
      ? formatAutomationAbsoluteTime(nextRunIso)
      : configuredOnceAt || t('panel.noNextRun')
    : t('panel.pausedPlan')

  const handleStatusToggle = (checked: boolean) => {
    if (checked) {
      void handleAction(detail.status === 'draft' ? 'activate' : 'resume')
      return
    }
    void handleAction('pause')
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 p-4 pb-0">
        {renderListBreadcrumb(detail.name)}
        <div className="mt-4 flex flex-wrap items-center gap-4 border-b border-foreground/[0.08] pb-4">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2.5">
              <h1 className="min-w-0 truncate text-heading font-semibold tracking-[-0.02em] text-foreground">
                {detail.name}
              </h1>
              {normalizedStatus === 'paused' ? (
                <TrackerStatusPill status={normalizedStatus} label={statusLabel} />
              ) : null}
            </div>
            {frequencyInfo.summary ? (
              <p className="mt-1 text-body text-muted-foreground/75">
                {isActive
                  ? t('detail.scheduleActive', {
                      schedule: frequencyInfo.summary,
                      defaultValue: '{{schedule}}',
                    })
                  : t('detail.schedulePaused', {
                      schedule: frequencyInfo.summary,
                      defaultValue: '{{schedule}} · 当前已暂停',
                    })}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Switch
              checked={isActive}
              disabled={Boolean(actionLoading)}
              onCheckedChange={handleStatusToggle}
              aria-label={isActive ? t('detail.actions.pause') : t('detail.actions.resume')}
              data-testid="tracker-detail-status-toggle"
            />
            {canTriggerManually ? (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <Button
                        size="sm"
                        className="h-9 rounded-lg px-3"
                        disabled={!!actionLoading || hasActiveRun}
                        onClick={() => handleAction('trigger')}
                        data-testid="tracker-detail-trigger"
                        aria-disabled={hasActiveRun || undefined}
                      >
                        {actionLoading === 'trigger'
                          ? <Loader2 className="h-[1em] w-[1em] animate-spin" />
                          : <Zap className="h-[1em] w-[1em]" />}
                        {t('detail.actions.trigger')}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {hasActiveRun ? (
                    <TooltipContent side="top">
                      {t('detail.actions.triggerDisabledActiveRun')}
                    </TooltipContent>
                  ) : null}
                </Tooltip>
              </TooltipProvider>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-lg px-3"
              disabled={!!actionLoading}
              onClick={() => setEditDialogOpen(true)}
              data-testid="tracker-detail-edit"
            >
              <Pencil className="h-[1em] w-[1em]" />
              {t('detail.actions.edit')}
            </Button>
          </div>
        </div>

        <CreateTrackerDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          spaceId={spaceId}
          editTracker={detail}
          onCreated={reloadTask}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
          <main className="min-w-0 space-y-4">
            <section className="rounded-[10px] border border-foreground/10 bg-background px-[18px] py-4">
              <div className={cn('flex', 'items-center', 'gap-1.5', 'font-semibold', CANVAS_TEXT_META)}>
                <FileText className="h-3.5 w-3.5" aria-hidden />
                {t('detail.instructions')}
              </div>
              <p
                className={cn(
                  'mt-3 whitespace-pre-wrap break-words text-body leading-[1.65]',
                  instructionsText ? 'text-foreground' : 'italic text-muted-foreground/60',
                )}
                data-testid="tracker-detail-instructions"
              >
                {instructionsText || t('detail.noInstructions')}
              </p>
            </section>

            <section className="overflow-hidden rounded-[10px] border border-foreground/10 bg-background">
              <div className="flex min-h-12 items-center justify-between gap-2 border-b border-foreground/[0.07] bg-foreground/[0.018] px-[18px] py-3">
                <div className="text-body font-semibold text-foreground">
                  {t('detail.runHistory')}
                </div>
              </div>
              <div className="divide-y divide-foreground/[0.06]">
                {runsLoading && runs.length === 0 ? (
                  <div className={cn('flex', 'items-center', 'gap-2', 'px-[18px]', 'py-6', CANVAS_TEXT_META)}>
                    <Loader2 className="h-[1em] w-[1em] animate-spin" />
                    {t('detail.loading')}
                  </div>
                ) : null}
                {!runsLoading && runs.length === 0 ? (
                  <p className={cn('px-[18px]', 'py-8', 'text-center', 'italic', 'text-muted-foreground/60', CANVAS_TEXT_META)}>
                    {t('detail.noRuns')}
                  </p>
                ) : null}
                {runs.map(run => (
                  <div key={run.id}>
                    <RunItem
                      run={run}
                      t={t}
                      onCancel={handleCancelRun}
                      onOpenSession={handleOpenRunSession}
                      isCancelling={cancelRunId === run.id}
                    />
                  </div>
                ))}
              </div>
            </section>
          </main>

          <aside className="min-w-0 lg:sticky lg:top-0">
            <section className="rounded-[10px] border border-foreground/10 bg-background px-[18px] py-4">
              <h2 className={cn('flex', 'items-center', 'gap-1.5', 'font-semibold', CANVAS_TEXT_META)}>
                <Clock className="h-3.5 w-3.5" aria-hidden />
                {t('detail.taskInfo')}
              </h2>
              <dl className="mt-4 space-y-4">
                <div className="space-y-1">
                  <dt className={CANVAS_TEXT_META}>{t('detail.nextRun')}</dt>
                  <dd className="min-w-0 break-words text-body font-medium tabular-nums text-foreground">{nextRunLabel}</dd>
                </div>
                <div className="space-y-1">
                  <dt className={CANVAS_TEXT_META}>{t('detail.workspace')}</dt>
                  <dd className="min-w-0 break-words text-body font-medium text-foreground">{workspaceLabel}</dd>
                </div>
                <div className="space-y-1">
                  <dt className={CANVAS_TEXT_META}>{t('detail.agent')}</dt>
                  <dd className="min-w-0 break-words text-body font-medium text-foreground">{resolvedAgentName}</dd>
                </div>
              </dl>

              {attentionReason ? (
                <div className={cn('mt-4', 'flex', 'items-start', 'gap-2', 'rounded-interactive', 'bg-warning/10', 'px-3', 'py-2', 'text-warning', CANVAS_TEXT_META_BASE)}>
                  <AlertCircle className="mt-0.5 h-[1em] w-[1em] shrink-0" aria-hidden />
                  <span>{t(`detail.health.${attentionReason}`)}</span>
                </div>
              ) : null}
              {missedSkipInfo ? (
                <div className={cn('mt-3', 'flex', 'items-start', 'gap-2', 'rounded-interactive', 'bg-warning/10', 'px-3', 'py-2', 'text-warning', CANVAS_TEXT_META_BASE)}>
                  <Clock className="mt-0.5 h-[1em] w-[1em] shrink-0" aria-hidden />
                  <span>{t('detail.health.missedSkipped', {
                    count: missedSkipInfo.count,
                    time: formatAutomationAbsoluteTime(missedSkipInfo.lastMissedAt),
                  })}</span>
                </div>
              ) : null}

              <button
                type="button"
                className="mt-4 inline-flex items-center gap-1 py-1 text-left text-body font-medium text-foreground transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setMoreOpen(open => !open)}
                aria-expanded={moreOpen}
                aria-controls="tracker-detail-more"
              >
                <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', moreOpen && 'rotate-90')} aria-hidden />
                <span>{t('detail.more.title')}</span>
              </button>

              {moreOpen ? (
                <dl id="tracker-detail-more" className="mt-3 space-y-4">
                  <div className="space-y-1">
                    <dt className={CANVAS_TEXT_META}>{t('detail.more.note')}</dt>
                    <dd
                      className={cn('whitespace-pre-wrap break-words text-body', noteText ? 'text-foreground' : 'italic text-muted-foreground/60')}
                      data-testid="tracker-detail-note"
                    >
                      {noteText || t('detail.more.noNote')}
                    </dd>
                  </div>
                  <div className="space-y-1">
                    <dt className={CANVAS_TEXT_META}>{t('detail.more.catchup')}</dt>
                    <dd className="text-body text-foreground">{t(`createDialog.catchup.${catchupPolicy}`)}</dd>
                  </div>
                  <div className="border-t border-foreground/[0.07] pt-3">
                    <dt className="sr-only">{t('detail.more.authorization')}</dt>
                    <dd className={cn('flex', 'items-start', 'gap-1.5', CANVAS_TEXT_META)}>
                      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>{t('createDialog.permissionNotice.hint')}</span>
                    </dd>
                  </div>
                </dl>
              ) : null}
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
