import React from 'react'
import { cn } from '@utils/cn'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import type { SessionLinkedWorktreeIndicator } from './resolveSessionLinkedWorktreeIndicator'

export interface SessionWorktreeIndicatorProps {
  indicator: SessionLinkedWorktreeIndicator
  /** 行 hover / focus-within 时淡出，让分叉/归档操作出现 */
  fadeOnRowHoverClassName: string
  label: string
}

/**
 * 并行任务路径：一个入口方块分出两条等权直角轨，各自落到任务方块。
 * 不用 Git 连枝 / 斜向分叉，也不用语义色。
 */
function WorktreeParallelIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        d="M1.25 8H3.25"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="square"
      />
      <rect
        x="3.25"
        y="6.5"
        width="3"
        height="3"
        rx="0.6"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M4.75 6.5V3.5H10.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <path
        d="M4.75 9.5V12.5H10.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <rect
        x="10.5"
        y="2"
        width="3"
        height="3"
        rx="0.6"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <rect
        x="10.5"
        y="11"
        width="3"
        height="3"
        rx="0.6"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  )
}

export const SessionWorktreeIndicator = React.memo(function SessionWorktreeIndicator({
  indicator,
  fadeOnRowHoverClassName,
  label,
}: SessionWorktreeIndicatorProps) {
  return (
    <ChatIconTooltip content={label}>
      <span
        data-testid="session-linked-worktree-indicator"
        data-worktree-path={indicator.path}
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground/80',
          '[@media(hover:hover)_and_(pointer:fine)]:group-hover:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:pointer-events-none',
          fadeOnRowHoverClassName,
        )}
        aria-label={label}
      >
        <WorktreeParallelIcon className="h-4 w-4" />
      </span>
    </ChatIconTooltip>
  )
})
SessionWorktreeIndicator.displayName = 'SessionWorktreeIndicator'
