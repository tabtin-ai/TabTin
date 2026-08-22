import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { AlertTriangle } from 'lucide-react'
import { ToolStepCard } from '../tool/ToolStepCard'
import { TodoPanel } from '../todo/TodoPanel'
import type { TodoItem } from '@stores/chat/shared/types'
import { MediaImageInlineCard } from '../cards/MediaImageInlineCard'
import { PresentationToolFoldRow } from './PresentationToolFoldRow'
import { ShinyText } from '../markdown/ShinyText'
import { partialReasonText, type ContentBlockEntry, type SiblingToolResult } from './types'
import type { ToolUseViewRoute } from './toolUseBlockViewLogic'
import {
  BORDER,
  CARD_RADIUS,
  STEP_ROW,
  TEXT,
  TEXT_COLOR,
} from '../registry/chatDesignTokens'
import { useSubagentRuns } from '../subagent/useSubagentRuns'
import { SubagentOrchestrationIcon } from '../subagent/SubagentOrchestrationIcon'
import { SubagentCheckStatusRow } from './SubagentCheckStatusRow'

type RouteRendererProps = {
  route: ToolUseViewRoute
  entry: ContentBlockEntry
  toolName: string
  toolDisplayName: string
  toolCallId: string
  effectiveInput: unknown
  inputFinalized: boolean
  phase: 'start' | 'running' | 'end' | 'error'
  decodedOutput: unknown
  lifecycleDurationMs?: number
  lifecycleStartedAt?: number
  intent?: string
  sessionId: string | null
  tabScopeKey?: string | null
  messageId?: string
  subagentRunSessionId?: string | null
  ownerRunId?: string
  siblingToolResult?: SiblingToolResult
  isStreaming?: boolean
  isLastAssistantMsg?: boolean
  suppressPartialReason?: boolean
  compactRow: React.ComponentType<{
    toolName: string
    input: unknown
    activity: 'calling' | 'executing' | 'done'
    inputFinalized: boolean
  }>
  subagentEntry: React.ComponentType<{
    parentToolCallId: string
    task?: string
    background?: boolean
    sessionId: string | null
    subagentRunSessionId?: string | null
    ownerRunId?: string
    siblingToolResult?: SiblingToolResult
    finalized: boolean
    isStreaming?: boolean
    isLastAssistantMsg?: boolean
  }>
  t: ReturnType<typeof useTranslation<'chat'>>['t']
}

function renderParseErrorView(props: RouteRendererProps): React.ReactNode {
  const { entry, toolDisplayName, t } = props
  return (
    <div
      className={cn('my-1 border px-3 py-2', CARD_RADIUS, BORDER.warning, 'bg-warning/5')}
      data-testid="block-tool-use-parse-error"
    >
      <div className={cn('flex items-center gap-1.5', TEXT.body, TEXT_COLOR.errorSoft)}>
        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate">
          {t('blockTimeline.toolUse.parseError', {
            name: toolDisplayName,
            defaultValue: `工具调用参数损坏：${toolDisplayName}`,
          })}
        </span>
      </div>
      <pre className={cn('mt-1 ml-5 max-h-[120px] overflow-auto whitespace-pre-wrap break-all', TEXT.code, TEXT_COLOR.muted)}>
        {entry.parseError?.partial}
      </pre>
    </div>
  )
}

function renderCompactInlineView(props: RouteRendererProps): React.ReactNode {
  const { route, toolName, effectiveInput, inputFinalized, compactRow: CompactRow } = props
  if (route.kind !== 'todo_compact' && route.kind !== 'compact_inline') return null
  return (
    <CompactRow
      toolName={toolName}
      input={effectiveInput}
      activity={route.activity}
      inputFinalized={inputFinalized}
    />
  )
}

function renderTodoCompletedView(props: RouteRendererProps): React.ReactNode {
  const { route } = props
  if (route.kind !== 'todo_completed') return null
  return (
    <div className={cn('my-1 overflow-hidden', CARD_RADIUS, 'border', BORDER.subtle)} data-testid="block-todo-completed">
      <TodoPanel todos={route.todos as TodoItem[]} />
    </div>
  )
}

function renderSubagentView(props: RouteRendererProps): React.ReactNode {
  const {
    route,
    toolCallId,
    sessionId,
    subagentRunSessionId,
    ownerRunId,
    siblingToolResult,
    entry,
    isStreaming,
    isLastAssistantMsg,
    subagentEntry: SubagentEntry,
  } = props
  if (route.kind !== 'subagent') return null
  return (
    <SubagentEntry
      parentToolCallId={toolCallId}
      task={route.task}
      background={route.background}
      sessionId={sessionId}
      subagentRunSessionId={subagentRunSessionId}
      ownerRunId={ownerRunId}
      siblingToolResult={siblingToolResult}
      finalized={entry.finalized}
      isStreaming={isStreaming}
      isLastAssistantMsg={isLastAssistantMsg}
    />
  )
}

function renderSubagentCheckView(props: RouteRendererProps): React.ReactNode {
  if (props.route.kind !== 'subagent_check') return null
  const { route } = props
  const isChecking =
    (route.phase === 'start' || route.phase === 'running')
    && (!route.status || route.status === 'checking')
  return (
    <SubagentCheckStatusRow
      items={[{
        childId: route.childId,
        ...(route.label ? { label: route.label } : {}),
        ...(route.status ? { status: route.status } : {}),
      }]}
      isChecking={isChecking}
      hasError={route.phase === 'error'}
    />
  )
}

const TERMINAL_SUBAGENT_STATUSES = new Set(['completed', 'failed', 'cancelled'])

type SubagentWaitRowState = 'waiting' | 'completed' | 'failed' | 'cancelled' | 'error'

function resolveSubagentWaitRowState(input: {
  phase: 'start' | 'running' | 'end' | 'error'
  status?: 'waiting' | 'completed' | 'error'
  isSettled: boolean
  failedCount: number
  cancelledCount: number
}): SubagentWaitRowState {
  if (input.phase === 'error' || input.status === 'error') return 'error'
  if (!input.isSettled) return 'waiting'
  if (input.failedCount > 0) return 'failed'
  if (input.cancelledCount > 0) return 'cancelled'
  return 'completed'
}

function settledSubagentWaitLabel(
  state: Exclude<SubagentWaitRowState, 'waiting'>,
  counts: { total: number; failed: number; cancelled: number },
  t: ReturnType<typeof useTranslation<'chat'>>['t'],
): string {
  if (state === 'error') {
    return t('subagent.wait.error', { defaultValue: '未能进入子任务等待' })
  }
  if (state === 'completed') {
    return t('subagent.wait.completed', {
      count: counts.total,
      defaultValue: `${counts.total} 个子任务已完成`,
    })
  }
  if (state === 'cancelled') {
    return t('subagent.wait.finishedWithCancellations', {
      count: counts.total,
      cancelled: counts.cancelled,
      defaultValue: `${counts.total} 个子任务已结束 · ${counts.cancelled} 个取消`,
    })
  }
  if (counts.cancelled > 0) {
    return t('subagent.wait.finishedWithFailuresAndCancellations', {
      count: counts.total,
      failed: counts.failed,
      cancelled: counts.cancelled,
      defaultValue:
        `${counts.total} 个子任务已结束 · ${counts.failed} 个失败` +
        ` · ${counts.cancelled} 个取消`,
    })
  }
  return t('subagent.wait.finishedWithFailures', {
    count: counts.total,
    failed: counts.failed,
    defaultValue: `${counts.total} 个子任务已结束 · ${counts.failed} 个失败`,
  })
}

const SubagentWaitStatusRow: React.FC<{
  childIds: string[]
  sessionId: string | null
  subagentRunSessionId?: string | null
  ownerRunId?: string
  phase: 'start' | 'running' | 'end' | 'error'
  status?: 'waiting' | 'completed' | 'error'
  completedChildIds: string[]
  failedChildIds: string[]
  cancelledChildIds: string[]
}> = ({
  childIds,
  sessionId,
  subagentRunSessionId,
  ownerRunId,
  phase,
  status,
  completedChildIds,
  failedChildIds,
  cancelledChildIds,
}) => {
  const { t } = useTranslation('chat')
  const runs = useSubagentRuns(
    subagentRunSessionId ?? sessionId,
    childIds,
    ownerRunId,
  )
  const settledRuns = runs.filter((run) => TERMINAL_SUBAGENT_STATUSES.has(run.status))
  const settledIds = new Set(completedChildIds)
  for (const run of settledRuns) settledIds.add(run.subagentRunId)
  const failedIds = new Set(failedChildIds)
  const cancelledIds = new Set(cancelledChildIds)
  for (const run of settledRuns) {
    if (run.status === 'failed') failedIds.add(run.subagentRunId)
    if (run.status === 'cancelled') cancelledIds.add(run.subagentRunId)
  }
  const settledCount = childIds.filter((childId) => settledIds.has(childId)).length
  const isSettled = childIds.length > 0
    && (status === 'completed' || settledCount === childIds.length)
  const state = resolveSubagentWaitRowState({
    phase,
    status,
    isSettled,
    failedCount: failedIds.size,
    cancelledCount: cancelledIds.size,
  })
  const errorIconTone = state === 'failed' || state === 'error'
  const errorLabelTone = state === 'failed'
  const settledLabel = state === 'waiting'
    ? null
    : settledSubagentWaitLabel(state, {
        total: childIds.length,
        failed: failedIds.size,
        cancelled: cancelledIds.size,
      }, t)

  return (
    <div
      className={STEP_ROW.inline}
      data-testid="block-subagent-wait"
      data-count={childIds.length}
      data-settled-count={settledCount}
      data-failed-count={failedIds.size}
      data-cancelled-count={cancelledIds.size}
      data-state={state}
    >
      <SubagentOrchestrationIcon
        className={errorIconTone ? TEXT_COLOR.errorSoft : STEP_ROW.icon}
      />
      {state === 'waiting' ? (
        <ShinyText className={STEP_ROW.label}>
          {childIds.length > 0
            ? t('subagent.wait.pending', {
                done: settledCount,
                total: childIds.length,
                defaultValue: `等待子任务完成 · ${settledCount}/${childIds.length}`,
              })
            : t('subagent.wait.starting', {
                defaultValue: '正在等待子任务完成',
              })}
        </ShinyText>
      ) : (
        <span className={cn(STEP_ROW.label, errorLabelTone && TEXT_COLOR.errorSoft)}>
          {settledLabel}
        </span>
      )}
    </div>
  )
}
SubagentWaitStatusRow.displayName = 'SubagentWaitStatusRow'

function renderSubagentWaitView(props: RouteRendererProps): React.ReactNode {
  const { route, sessionId, subagentRunSessionId, ownerRunId } = props
  if (route.kind !== 'subagent_wait') return null
  return (
    <SubagentWaitStatusRow
      childIds={route.childIds}
      sessionId={sessionId}
      subagentRunSessionId={subagentRunSessionId}
      ownerRunId={ownerRunId}
      phase={route.phase}
      status={route.status}
      completedChildIds={route.completedChildIds}
      failedChildIds={route.failedChildIds}
      cancelledChildIds={route.cancelledChildIds}
    />
  )
}

function renderMediaImageView(props: RouteRendererProps): React.ReactNode {
  const {
    route,
    phase,
    decodedOutput,
    lifecycleStartedAt,
    sessionId,
    messageId,
    toolCallId,
  } = props
  if (route.kind !== 'media_image') return null
  return (
    <MediaImageInlineCard
      phase={phase}
      command={route.command}
      promptPreview={route.promptPreview}
      output={decodedOutput}
      startedAtMs={lifecycleStartedAt}
      sessionId={sessionId}
      messageId={messageId}
      sourceToolUseId={toolCallId}
    />
  )
}

function renderPresentationFoldView(props: RouteRendererProps): React.ReactNode {
  const { route, toolName, effectiveInput, entry, inputFinalized } = props
  if (route.kind !== 'presentation_fold') return null
  return (
    <PresentationToolFoldRow
      toolName={toolName}
      input={effectiveInput}
      finalized={entry.finalized}
      inputFinalized={inputFinalized}
    />
  )
}

function renderToolStepCardView(props: RouteRendererProps): React.ReactNode {
  const {
    entry,
    toolCallId,
    toolName,
    phase,
    inputFinalized,
    effectiveInput,
    decodedOutput,
    lifecycleDurationMs,
    lifecycleStartedAt,
    intent,
    sessionId,
    tabScopeKey,
    suppressPartialReason,
    t,
  } = props
  if (props.route.kind !== 'tool_step_card') return null
  return (
    <div data-testid="block-tool-use">
      <ToolStepCard
        id={toolCallId}
        toolName={toolName}
        phase={phase}
        inputFinalized={inputFinalized}
        input={effectiveInput}
        output={decodedOutput}
        durationMs={lifecycleDurationMs}
        startedAt={lifecycleStartedAt}
        intent={intent}
        sessionId={sessionId}
        tabScopeKey={tabScopeKey}
      />
      {entry.partial && !suppressPartialReason && (
        <div className={cn('mt-1 pl-3', TEXT.meta, TEXT_COLOR.faint, 'italic')}>
          {partialReasonText(entry.partialReason, t)}
        </div>
      )}
    </div>
  )
}

const ROUTE_RENDERERS: Record<ToolUseViewRoute['kind'], (props: RouteRendererProps) => React.ReactNode> = {
  parse_error: renderParseErrorView,
  todo_compact: renderCompactInlineView,
  todo_completed: renderTodoCompletedView,
  todo_hidden: () => null,
  subagent: renderSubagentView,
  subagent_pending: () => null,
  subagent_check: renderSubagentCheckView,
  subagent_wait: renderSubagentWaitView,
  media_image: renderMediaImageView,
  presentation_hidden: () => null,
  presentation_fold: renderPresentationFoldView,
  compact_inline: renderCompactInlineView,
  tool_step_card: renderToolStepCardView,
}

export type ToolUseRoutedViewProps = Omit<RouteRendererProps, 't'>

export const ToolUseRoutedView: React.FC<ToolUseRoutedViewProps> = (props) => {
  const { t } = useTranslation('chat')
  return ROUTE_RENDERERS[props.route.kind]({ ...props, t })
}
