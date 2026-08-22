/**
 * TodoCard — structured rendering for todo tool.
 *
 * Displays a todo list with checkbox styling and status color coding.
 * Self-registers as 'TodoCard'.
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Circle, CirclePause, Loader2, XCircle } from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@components/ui'
import type { CardRendererProps } from '../registry/types'
import {
  CARD_HEADER_PADDING,
  CARD_PADDING,
  CARD_MAX_HEIGHT,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  ICON_SIZE,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { ErrorBanner, LoadingPlaceholder } from './primitives'

interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'paused' | 'completed' | 'cancelled'
}

const STATUS_CONFIG = {
  completed: {
    icon: CheckCircle2,
    color: 'text-success',
    bgColor: 'bg-success/10',
    textDecoration: 'line-through opacity-60',
  },
  in_progress: {
    icon: Loader2,
    color: 'text-accent',
    bgColor: 'bg-accent/10',
    textDecoration: '',
  },
  pending: {
    icon: Circle,
    color: TEXT_COLOR.muted,
    bgColor: '',
    textDecoration: '',
  },
  paused: {
    icon: CirclePause,
    color: TEXT_COLOR.muted,
    bgColor: '',
    textDecoration: '',
  },
  cancelled: {
    icon: XCircle,
    color: TEXT_COLOR.faint,
    bgColor: '',
    textDecoration: 'line-through opacity-40',
  },
} as const

function getNestedArgs(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  return (obj.kwargs as Record<string, unknown>) ?? obj
}

const TodoCardRenderer: React.FC<CardRendererProps> = React.memo(
  ({ input, error, phase }) => {
    const { t } = useTranslation('chat')

    const todos = useMemo((): TodoItem[] => {
      const args = getNestedArgs(input)
      const rawTodos = args?.todos as Array<Record<string, unknown>> | undefined
      if (!Array.isArray(rawTodos)) return []
      return rawTodos.map((item, i) => ({
        id: String(item.id ?? `todo-${i}`),
        content: String(item.content ?? ''),
        status: (['completed', 'in_progress', 'paused', 'pending', 'cancelled'].includes(String(item.status))
          ? String(item.status)
          : 'pending') as TodoItem['status'],
      }))
    }, [input])

    const counts = useMemo(() => {
      const c = { completed: 0, in_progress: 0, paused: 0, pending: 0, cancelled: 0 }
      for (const todo of todos) c[todo.status]++
      return c
    }, [todos])

    // 失败 / 被用户拒绝（phase='error'）：绝不把工具**入参**里的 todos 当"已创建"渲染。
    // 待办真正落库只在工具执行成功（phase='end'）时由 setTodosForSession 写入 docked 面板；
    // 失败态交给 ErrorBanner（遵循「工具错误改由 Agent 处置」：生产默认隐藏、DEBUG 面板可见），
    // 修复"拒绝创建待办后仍被渲染成已创建、且状态永不更新"（input 快照被误当结果）。
    if (error || phase === 'error') {
      return <ErrorBanner error={error} />
    }
    if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />

    if (todos.length === 0) {
      return (
        <div className={'overflow-hidden'}>
          <div className={cn(CARD_PADDING.x, 'py-2', TEXT.meta, TEXT_COLOR.muted, 'italic')}>
            {t('card.generic_no_content', 'No content')}
          </div>
        </div>
      )
    }

    return (
      <div className={'overflow-hidden'}>
        {/* Header */}
        <div
          className={cn(
            'flex items-center gap-1.5',
            CARD_HEADER_PADDING.x,
            CARD_HEADER_PADDING.y,
            BG.header,
            'border-b',
            BORDER.subtle,
          )}
        >
          <CheckCircle2 className={cn(ICON_SIZE.md, TEXT_COLOR.muted)} />
          <span className={cn(TEXT.label, TEXT_COLOR.muted)}>
            {t('card.todo', 'Todo')}
          </span>
          <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'ml-auto')}>
            {counts.completed}/{todos.length}
          </span>
        </div>

        {/* Todo list */}
        <ScrollArea className={CARD_MAX_HEIGHT.md} scrollBar="vertical">
          <div className="divide-y divide-border/10">
            {todos.map((todo) => {
              const config = STATUS_CONFIG[todo.status]
              const Icon = config.icon

              return (
                <div
                  key={todo.id}
                  className={cn(
                    'flex items-start gap-2',
                    CARD_PADDING.x,
                    'py-1.5',
                    config.bgColor,
                  )}
                >
                  <Icon
                    className={cn(
                      ICON_SIZE.status,
                      'shrink-0 mt-0.5',
                      config.color,
                      todo.status === 'in_progress' && 'animate-spin',
                    )}
                  />
                  <span
                    className={cn(
                      TEXT.body,
                      TEXT_COLOR.secondary,
                      config.textDecoration,
                      'min-w-0 break-words',
                    )}
                  >
                    {todo.content}
                  </span>
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </div>
    )
  },
)

TodoCardRenderer.displayName = 'TodoCardRenderer'

registerCardRenderer('TodoCard', TodoCardRenderer)

export { TodoCardRenderer }
export default TodoCardRenderer
