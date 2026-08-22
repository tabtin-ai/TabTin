/**
 * SaveStateIndicator — 统一保存状态指示器
 *
 * 从 TabDoc 的 SaveState 模式提炼。
 * 所有需要显示保存状态的模块（TabData、TabDoc、TabSlide）统一使用。
 *
 * @example
 * <SaveStateIndicator state="saving" />
 * <SaveStateIndicator state="dirty" message="3 个未保存修改" variant="badge" />
 * <SaveStateIndicator state="saved" variant="dot" />
 */

import * as React from 'react'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface SaveStateIndicatorProps {
  /** 保存状态 */
  state: SaveState
  /** 附加信息（如版本号、错误描述等） */
  message?: string
  /** 展示变体：text=文字、dot=圆点、badge=标签 */
  variant?: 'text' | 'dot' | 'badge'
  /** 是否显示图标（仅 text 和 badge 变体） */
  showIcon?: boolean
  /** 额外 className */
  className?: string
}

const STATE_COLORS: Record<SaveState, string> = {
  idle: 'text-muted-foreground',
  dirty: 'text-warning',
  saving: 'text-info',
  saved: 'text-success',
  error: 'text-destructive',
}

const STATE_DOT_COLORS: Record<SaveState, string> = {
  idle: 'bg-muted-foreground',
  dirty: 'bg-warning',
  saving: 'bg-info',
  saved: 'bg-success',
  error: 'bg-destructive',
}

const STATE_BADGE_COLORS: Record<SaveState, string> = {
  idle: 'bg-muted text-muted-foreground',
  dirty: 'bg-warning/15 text-warning',
  saving: 'bg-info/15 text-info',
  saved: 'bg-success/15 text-success',
  error: 'bg-destructive/10 text-destructive',
}

function getStateLabel(state: SaveState): string {
  return t(`saveState.${state}`)
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  )
}

export const SaveStateIndicator: React.FC<SaveStateIndicatorProps> = ({
  state,
  message,
  variant = 'text',
  showIcon = true,
  className,
}) => {
  const label = message || getStateLabel(state)

  // ── Dot 变体 ──
  if (variant === 'dot') {
    return (
      <div className={cn('flex items-center gap-1.5', className)} title={label}>
        <span
          className={cn(
            'inline-block h-2 w-2 rounded-full',
            STATE_DOT_COLORS[state],
            state === 'saving' && 'animate-pulse',
          )}
        />
        {message && (
          <span className={cn('text-body', STATE_COLORS[state])}>{message}</span>
        )}
      </div>
    )
  }

  // ── Badge 变体 ──
  if (variant === 'badge') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-body font-medium',
          STATE_BADGE_COLORS[state],
          className,
        )}
      >
        {showIcon && state === 'saving' && (
          <SpinnerIcon className="h-3 w-3" />
        )}
        {showIcon && state === 'dirty' && (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
        )}
        {label}
      </span>
    )
  }

  // ── Text 变体（默认） ──
  return (
    <div className={cn('flex items-center gap-1.5 text-body', STATE_COLORS[state], className)}>
      {showIcon && state === 'saving' && (
        <SpinnerIcon className="h-3 w-3" />
      )}
      {showIcon && state === 'dirty' && (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {showIcon && state === 'saved' && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {showIcon && state === 'error' && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      )}
      <span className="font-medium">{label}</span>
    </div>
  )
}

SaveStateIndicator.displayName = 'SaveStateIndicator'
