/**
 * TodoPanel — Agent 待办事项列表面板
 *
 * 以紧凑列表展示 Agent 创建的 todos，实时更新进度。
 */

import React, { useMemo, useState } from 'react'
import {
  CheckCircle2,
  Circle,
  CirclePause,
  Loader2,
  XCircle,
  ChevronDown,
  ChevronRight,
  ListTodo,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import type { TodoItem } from '@stores/chat/shared/types'

const STATUS_ICON: Record<TodoItem['status'], React.ElementType> = {
  pending: Circle,
  in_progress: Loader2,
  paused: CirclePause,
  completed: CheckCircle2,
  cancelled: XCircle,
}

const STATUS_STYLE: Record<TodoItem['status'], string> = {
  pending: 'text-muted-foreground/60',
  in_progress: 'text-accent animate-spin',
  paused: 'text-muted-foreground/60',
  completed: 'text-success',
  cancelled: 'text-muted-foreground/40 line-through',
}

interface TodoPanelProps {
  todos: TodoItem[]
  /**
   * 摘要条已经承担标题、进度和展开控制时，详情层只展示列表，避免出现第二层折叠入口。
   */
  showHeader?: boolean
  /**
   * 会话未在运行（用户中断 / 轮次已结束）时为 true。待办是 todo block 的
   * 纯派生视图，中断不会产生新数据把 in_progress 改掉——run 停了还转圈会误导
   * 用户"还在跑"，所以由渲染层按运行态把 in_progress 降为暂停图标。
   */
  paused?: boolean
}

export const TodoPanel: React.FC<TodoPanelProps> = ({
  todos,
  showHeader = true,
  paused = false,
}) => {
  const { t } = useTranslation('chat')
  const [collapsed, setCollapsed] = useState(false)

  const progress = useMemo(() => {
    const active = todos.filter(t => t.status !== 'cancelled')
    const done = active.filter(t => t.status === 'completed').length
    return { done, total: active.length }
  }, [todos])

  if (todos.length === 0) return null

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  const progressText = t('card.todoProgressText', {
    done: progress.done,
    total: progress.total,
    defaultValue: '{{done}}/{{total}}',
  })
  const toggleLabel = t('card.todoProgressToggleLabel', {
    done: progress.done,
    total: progress.total,
    defaultValue: '待办事项，已完成 {{done}} / {{total}}',
  })

  return (
    <div className="overflow-hidden rounded-lg bg-background/95">
      {/* Header */}
      {showHeader && (
        <button
          onClick={() => setCollapsed(prev => !prev)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-body font-medium text-muted-foreground hover:bg-muted/10 transition-colors"
          aria-label={toggleLabel}
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          <ListTodo className="h-3 w-3" />
          <span>{t('card.todo', { defaultValue: '待办事项' })}</span>
          <span className="ml-auto tabular-nums">
            {progressText}
          </span>
        </button>
      )}

      {/* Progress bar */}
      {showHeader && progress.total > 0 && (
        <div className="h-0.5 bg-muted/20">
          <div
            className={cn(
              'h-full transition-all duration-500 ease-out',
              pct === 100 ? 'bg-success' : 'bg-accent',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {/* List */}
      {(!showHeader || !collapsed) && (
        <ul className="px-3 py-1">
          {todos.map(todo => {
            const isPausedInProgress = paused && todo.status === 'in_progress'
            const isPausedStatus = todo.status === 'paused'
            const Icon = isPausedInProgress ? CirclePause : STATUS_ICON[todo.status]
            const style = isPausedInProgress ? 'text-muted-foreground/60' : STATUS_STYLE[todo.status]
            return (
              <li key={todo.id} className="flex min-w-0 items-start gap-2 py-1 text-body">
                <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', style)} />
                <span
                  className={cn(
                    'min-w-0 flex-1 break-words leading-snug [overflow-wrap:anywhere]',
                    todo.status === 'cancelled' && 'text-muted-foreground/40 line-through',
                    isPausedStatus && 'text-muted-foreground/70',
                    todo.status === 'completed' && 'text-muted-foreground/80',
                  )}
                >
                  {todo.content}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default TodoPanel
