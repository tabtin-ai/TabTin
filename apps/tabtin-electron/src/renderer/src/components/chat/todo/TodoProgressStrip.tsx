import React, { useMemo } from 'react'
import {
  CheckCircle2,
  ChevronUp,
  Circle,
  CirclePause,
  ListTodo,
  Loader2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  OVERLAY_SURFACE_CLASS,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@components/ui'
import { cn } from '@utils/cn'
import type { TodoItem } from '@stores/chat/shared/types'
import type { ChatTranslate } from '../registry/toolDisplayName'
import { TodoPanel } from './TodoPanel'

interface TodoProgressStripProps {
  todos: TodoItem[]
  paused?: boolean
  awaitingSubagents?: boolean
}

interface TodoStripView {
  done: number
  total: number
  label: string
  openLabel: string
  progressText: string
  progressScale: number
  Icon: React.ElementType
  iconClassName: string
  progressClassName: string
}

function resolveTodoIcon(
  isComplete: boolean,
  isPausedCurrent: boolean,
  isInProgress: boolean,
): React.ElementType {
  if (isComplete) return CheckCircle2
  if (isPausedCurrent) return CirclePause
  if (isInProgress) return Loader2
  return Circle
}

function resolveTodoLabel(
  t: ChatTranslate,
  isComplete: boolean,
  isPausedCurrent: boolean,
  isAwaitingSubagentsCurrent: boolean,
  content: string | undefined,
): string {
  if (isComplete) {
    return t('card.todoAllDone', { defaultValue: '待办已完成' })
  }
  if (isAwaitingSubagentsCurrent) {
    return t('card.todoAwaitingSubagents', {
      content,
      defaultValue: '等待子任务：{{content}}',
    })
  }
  if (isPausedCurrent) {
    return t('card.todoPausedCurrent', {
      content,
      defaultValue: '已暂停：{{content}}',
    })
  }
  return t('card.todoCurrent', {
    content,
    defaultValue: '当前：{{content}}',
  })
}

function createTodoStripView(
  todos: TodoItem[],
  paused: boolean,
  awaitingSubagents: boolean,
  t: ChatTranslate,
): TodoStripView {
  const active = todos.filter(todo => todo.status !== 'cancelled')
  const done = active.filter(todo => todo.status === 'completed').length
  const current = active.find(todo => todo.status === 'in_progress')
    ?? active.find(todo => todo.status === 'paused')
    ?? active.find(todo => todo.status === 'pending')
    ?? active.at(-1)
  const total = active.length
  const isComplete = total > 0 && done === total
  const isInProgress = current?.status === 'in_progress'
  const isAwaitingSubagentsCurrent = awaitingSubagents && isInProgress
  const isPausedCurrent = current?.status === 'paused' || (paused && isInProgress && !isAwaitingSubagentsCurrent)
  const isRunning = isInProgress && !paused && !isAwaitingSubagentsCurrent && !isComplete
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  return {
    done,
    total,
    label: resolveTodoLabel(t, isComplete, isPausedCurrent, isAwaitingSubagentsCurrent, current?.content),
    openLabel: t('card.todoOpenDetails', {
      done,
      total,
      defaultValue: '查看全部待办，已完成 {{done}} / {{total}}',
    }),
    progressText: t('card.todoProgressText', {
      done,
      total,
      defaultValue: '{{done}}/{{total}}',
    }),
    progressScale: pct / 100,
    Icon: resolveTodoIcon(isComplete, isPausedCurrent, isInProgress),
    iconClassName: cn(
      'h-3.5 w-3.5 shrink-0',
      isComplete ? 'text-success' : isPausedCurrent ? 'text-muted-foreground/60' : 'text-accent',
      isRunning && 'animate-spin',
    ),
    progressClassName: isComplete ? 'bg-success' : 'bg-accent',
  }
}

export function TodoProgressStrip({
  todos,
  paused = false,
  awaitingSubagents = false,
}: TodoProgressStripProps) {
  const { t } = useTranslation('chat')
  const view = useMemo(
    () => createTodoStripView(todos, paused, awaitingSubagents, t),
    [awaitingSubagents, paused, t, todos],
  )

  if (todos.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'group relative flex h-9 w-full min-w-0 items-center gap-2 overflow-hidden',
            'rounded-interactive px-3 text-left text-body text-muted-foreground',
            'transition-colors hover:bg-foreground/[0.03] hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          )}
          aria-label={view.openLabel}
          data-testid="todo-progress-strip"
        >
          <ListTodo className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          <view.Icon
            className={view.iconClassName}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate">{view.label}</span>
          <span className="shrink-0 text-caption tabular-nums text-muted-foreground/60">
            {view.progressText}
          </span>
          <ChevronUp
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform group-data-[state=open]:rotate-180"
            aria-hidden
          />
          {view.total > 0 && (
            <span
              className={cn(
                'pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left',
                view.progressClassName,
                'transition-transform duration-500 ease-out',
              )}
              style={{ transform: `scaleX(${view.progressScale})` }}
              aria-hidden
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        data-testid="todo-progress-details"
        className={cn(
          OVERLAY_SURFACE_CLASS,
          'z-dropdown w-[min(32rem,var(--radix-popover-trigger-width))]',
          'max-w-[var(--radix-popover-content-available-width)] rounded-interactive p-1',
        )}
      >
        <TodoPanel todos={todos} showHeader={false} paused={paused} />
      </PopoverContent>
    </Popover>
  )
}
