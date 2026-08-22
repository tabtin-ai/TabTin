/**
 * AgentWorkbenchExpandCard — AI 分身工作台横排入口卡：摘要 + 点击进入画布内整页。
 */

import React from 'react'
import { Maximize2 } from 'lucide-react'
import { cn } from '@utils/cn'

/** 卡片标题：主色，避免 muted/70 看起来像禁用 */
const CARD_TITLE = 'text-body font-medium text-foreground antialiased'
/** 卡片副标题 / 摘要：次要但仍可读（设计系统 /80） */
const CARD_SUBTITLE = 'text-body leading-[22px] text-muted-foreground/80 antialiased'

interface AgentWorkbenchExpandCardProps {
  title: string
  icon?: React.ReactNode
  preview?: React.ReactNode
  onOpen: () => void
  className?: string
}

export const AgentWorkbenchExpandCard: React.FC<AgentWorkbenchExpandCardProps> = ({
  title,
  icon,
  preview,
  onOpen,
  className,
}) => (
  <section
    className={cn(
      'flex min-w-0 flex-col rounded-[12px] border border-border/40 bg-muted/10',
      className,
    )}
  >
    <button
      type="button"
      onClick={onOpen}
      className="flex h-full w-full flex-1 items-start gap-2 px-3 py-3 text-left transition-colors hover:bg-muted/20"
    >
      <div className="min-w-0 flex-1">
        <div className={cn('flex min-w-0 items-center gap-1.5', CARD_TITLE)}>
          {icon ? (
            <span className="inline-flex shrink-0 text-accent" aria-hidden>
              {icon}
            </span>
          ) : null}
          <span className="truncate">{title}</span>
        </div>
        {preview ? (
          <div className={cn('mt-1 line-clamp-2', CARD_SUBTITLE)}>
            {preview}
          </div>
        ) : null}
      </div>
      <Maximize2
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/80"
        aria-hidden
      />
    </button>
  </section>
)

interface AgentWorkbenchPaneProps {
  title: string
  icon?: React.ReactNode
  subtitle?: string
  actions?: React.ReactNode
  className?: string
  children: React.ReactNode
}

/** 下区记忆 / 任务面板共用壳 */
export const AgentWorkbenchPane: React.FC<AgentWorkbenchPaneProps> = ({
  title,
  icon,
  subtitle,
  actions,
  className,
  children,
}) => (
  <section
    className={cn(
      'flex h-full min-h-[280px] min-w-0 flex-col overflow-hidden rounded-[12px] border border-border/40 bg-muted/10',
      className,
    )}
  >
    <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border/30 px-4 py-3">
      <div className="min-w-0">
        <h3 className={cn('flex min-w-0 items-center gap-1.5', CARD_TITLE)}>
          {icon ? (
            <span className="inline-flex shrink-0 text-accent" aria-hidden>
              {icon}
            </span>
          ) : null}
          <span className="truncate">{title}</span>
        </h3>
        {subtitle ? (
          <p className={cn('mt-0.5', CARD_SUBTITLE)}>{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover">
      {children}
    </div>
  </section>
)
