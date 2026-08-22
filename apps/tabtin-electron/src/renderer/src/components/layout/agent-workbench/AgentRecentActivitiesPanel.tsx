/**
 * AgentRecentActivitiesPanel — 分身工作台右侧：Chat + Project Task 混合活动流。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CheckSquare2, Loader2, MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChatSessionWithAgent } from '@tabtin/chat-client'
import type { ProjectTask } from '@/types/project'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { formatAgentRelativeTime } from '@components/settings/panels/MyAgentsPanel'
import {
  activityRowKey,
  fetchAgentWorkbenchActivities,
  type AgentWorkbenchActivity,
  type AgentWorkbenchProjectTaskActivity,
} from '@/services/agentWorkbenchActivities'
import { openAgentWorkbenchActivity } from '@/services/openAgentWorkbenchActivity'

interface AgentRecentActivitiesPanelProps {
  organizationId: string
  agentId: string
}

const PROJECT_WORK_STATUS_LABEL: Record<ProjectTask['work_status'], string> = {
  todo: '待执行',
  in_progress: '执行中',
  in_review: '执行中',
  blocked: '受阻',
  done: '已完成',
  cancelled: '已取消',
}

function chatStatusLabel(
  session: ChatSessionWithAgent,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | null {
  if (session.has_active_task) {
    return t('myAgents.workbench.taskRunning', { defaultValue: '执行中' })
  }
  if (session.has_unread_reply) {
    return t('myAgents.workbench.taskUnread', { defaultValue: '有新回复' })
  }
  if (session.status === 'archived') {
    return t('myAgents.workbench.taskArchived', { defaultValue: '已归档' })
  }
  return null
}

function projectTaskStatusLabel(
  task: ProjectTask,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | null {
  if (task.assignment_status === 'pending') {
    return t('myAgents.workbench.projectPending', { defaultValue: '待接单' })
  }
  if (task.assignment_status === 'rejected') {
    return t('myAgents.workbench.projectRejected', { defaultValue: '已拒绝' })
  }
  const runStatus = task.latest_run?.status
  if (runStatus === 'running' || runStatus === 'pending' || runStatus === 'preparing') {
    return t('myAgents.workbench.taskRunning', { defaultValue: '执行中' })
  }
  if (runStatus === 'failed') {
    return t('myAgents.workbench.projectRunFailed', { defaultValue: '执行失败' })
  }
  return PROJECT_WORK_STATUS_LABEL[task.work_status] ?? null
}

const META_BADGE = cn(
  'inline-flex max-w-full truncate rounded-full bg-foreground/[0.06] px-1.5 py-px',
  CANVAS_TEXT_MICRO,
  'text-muted-foreground',
)

const ActivityRowShell: React.FC<{
  icon: React.ReactNode
  title: string
  status: string | null
  preview: string | null
  contextLabel: string | null
  timeLabel: string | null
  onOpen: () => void
}> = ({ icon, title, status, preview, contextLabel, timeLabel, onOpen }) => (
  <button
    type="button"
    onClick={onOpen}
    className={cn(
      'grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 gap-y-1 border-b border-border/20 px-3 py-2.5 text-left transition-colors last:border-b-0',
      'hover:bg-muted/25',
    )}
  >
    <span className="col-start-1 row-start-1 inline-flex self-center text-muted-foreground/60" aria-hidden>
      {icon}
    </span>
    <div className="col-start-2 row-start-1 flex min-w-0 items-center justify-between gap-2">
      <span className="min-w-0 truncate text-body text-foreground">{title}</span>
      {status ? (
        <span className={cn(META_BADGE, 'shrink-0')}>{status}</span>
      ) : null}
    </div>
    {preview ? (
      <span className={cn('col-start-2 line-clamp-2', CANVAS_TEXT_META)}>{preview}</span>
    ) : null}
    {(contextLabel || timeLabel) ? (
      <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-1.5">
        {contextLabel ? (
          <span className={META_BADGE}>{contextLabel}</span>
        ) : null}
        {timeLabel ? (
          <span className={META_BADGE}>{timeLabel}</span>
        ) : null}
      </div>
    ) : null}
  </button>
)

const ActivityRow: React.FC<{
  activity: AgentWorkbenchActivity
  onOpen: () => void
}> = ({ activity, onOpen }) => {
  const { t } = useTranslation('settings')

  if (activity.kind === 'chat') {
    const { session } = activity
    const status = chatStatusLabel(session, t)
    const timeLabel = formatAgentRelativeTime(
      session.last_message_at ?? session.updated_at,
      t,
    )
    const preview = session.last_message_preview?.trim()
      || (session.message_count
        ? t('myAgents.workbench.taskHasMessages', { defaultValue: '已有对话内容' })
        : null)

    return (
      <ActivityRowShell
        icon={<MessageSquare className="h-3.5 w-3.5" />}
        title={session.title || t('myAgents.workbench.untitledTask', { defaultValue: '新对话' })}
        status={status}
        preview={preview}
        contextLabel={session.space_name?.trim() || null}
        timeLabel={timeLabel}
        onOpen={onOpen}
      />
    )
  }

  const { task, projectName } = activity as AgentWorkbenchProjectTaskActivity
  const status = projectTaskStatusLabel(task, t)
  const timeLabel = formatAgentRelativeTime(task.updated_at, t)
  const preview = task.result_summary?.trim()
    || task.description?.trim()
    || null

  return (
    <ActivityRowShell
      icon={<CheckSquare2 className="h-3.5 w-3.5" />}
      title={task.title}
      status={status}
      preview={preview}
      contextLabel={projectName?.trim() || null}
      timeLabel={timeLabel}
      onOpen={onOpen}
    />
  )
}

export const AgentRecentActivitiesPanel: React.FC<AgentRecentActivitiesPanelProps> = ({
  organizationId,
  agentId,
}) => {
  const { t } = useTranslation('settings')
  const scope = `${organizationId}:${agentId}`
  const requestGeneration = useRef(0)
  const [state, setState] = useState({
    scope,
    activities: [] as AgentWorkbenchActivity[],
    loading: true,
    error: false,
  })
  const isCurrentScope = state.scope === scope

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current
    setState({
      scope,
      activities: [],
      loading: true,
      error: false,
    })
    try {
      const next = await fetchAgentWorkbenchActivities({
        organizationId,
        agentId,
        limit: 20,
      })
      if (generation !== requestGeneration.current) return
      setState({
        scope,
        activities: next,
        loading: false,
        error: false,
      })
    } catch {
      if (generation !== requestGeneration.current) return
      setState({
        scope,
        activities: [],
        loading: false,
        error: true,
      })
    }
  }, [agentId, organizationId, scope])

  useEffect(() => {
    void load()
    return () => {
      requestGeneration.current += 1
    }
  }, [load])

  const handleOpen = useCallback((activity: AgentWorkbenchActivity) => {
    void openAgentWorkbenchActivity({ organizationId, activity })
  }, [organizationId])

  if (!isCurrentScope || state.loading) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-10 text-body text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('myAgents.workbench.tasksLoading', { defaultValue: '正在加载任务…' })}
      </div>
    )
  }

  if (state.error) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <p className={CANVAS_TEXT_SECONDARY}>
          {t('myAgents.workbench.tasksLoadFailed', { defaultValue: '任务列表加载失败' })}
        </p>
        <button
          type="button"
          className="text-body text-accent hover:underline"
          onClick={() => { void load() }}
        >
          {t('myAgents.retry', { defaultValue: '重试' })}
        </button>
      </div>
    )
  }

  if (state.activities.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <MessageSquare className="h-5 w-5 text-muted-foreground/50" />
        <p className={CANVAS_TEXT_SECONDARY}>
          {t('myAgents.workbench.tasksEmpty', { defaultValue: '这个 AI 分身还没有任务记录' })}
        </p>
      </div>
    )
  }

  return (
    <div className="py-1">
      {state.activities.map((activity) => (
        <ActivityRow
          key={activityRowKey(activity)}
          activity={activity}
          onOpen={() => handleOpen(activity)}
        />
      ))}
    </div>
  )
}

/** @deprecated 使用 AgentRecentActivitiesPanel */
export const AgentRecentChatSessionsPanel = AgentRecentActivitiesPanel
