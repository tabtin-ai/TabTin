/**
 * TerminalPaneHeader - 终端分屏 pane 的 mini 标题栏
 *
 * 显示会话信息（标题、cwd）及操作按钮（重启、最大化、分屏、关闭）。
 * 仅在多 pane 场景下由 TerminalSplitContainer 渲染。
 */

import React, { useCallback } from 'react'
import { cn } from '@utils/cn'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@tabtin/smartsheet-ui'
import { X, Maximize2, Minimize2, Columns2, Rows2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  useTerminalSplitStore,
  type TerminalSplitPane,
} from '@stores/useTerminalSplitStore'
import {
  useTerminalSessionStore,
} from '@components/context-space/sources/terminal'
import { useTerminalPaneStatusStore, type PaneStatus } from '@stores/useTerminalPaneStatusStore'
import { createSplitPane, closeSplitPane } from './terminalSplitActions'

interface TerminalPaneHeaderProps {
  pane: TerminalSplitPane
  isActive: boolean
  isMaximized: boolean
  rootSessionId: string
  /** 触发 pane 内终端实例重建（key bump） */
  onRestartPane?: (sessionId: string) => void
}

const STATUS_LABELS: Record<PaneStatus, string> = {
  idle: 'idle',
  running: 'running',
  exited: 'exited',
}

const PaneStatusIndicator: React.FC<{ status: PaneStatus; isActive: boolean }> = ({
  status,
  isActive,
}) => {
  const { t } = useTranslation('terminal')
  const base = 'h-1.5 w-1.5 flex-shrink-0 rounded-full transition-colors'
  const label = t(`status.${STATUS_LABELS[status]}`)

  const dot = (() => {
    if (status === 'running') {
      return (
        <span
          className={cn(base, 'bg-warning motion-safe:animate-[pane-pulse_1.4s_ease-in-out_infinite]')}
          aria-label={label}
          role="status"
        />
      )
    }
    if (status === 'exited') {
      return <span className={cn(base, 'bg-destructive/60')} aria-label={label} role="status" />
    }
    return (
      <span
        className={cn(base, isActive ? 'bg-success' : 'bg-muted-foreground/30')}
        aria-label={label}
        role="status"
      />
    )
  })()

  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>{dot}</TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

PaneStatusIndicator.displayName = 'PaneStatusIndicator'

/** 截取 cwd 路径的最后两级目录 */
const truncateCwd = (cwd: string): string => {
  if (!cwd) return ''
  const parts = cwd.replace(/\/+$/, '').split('/')
  if (parts.length <= 2) return cwd
  return '~/' + parts.slice(-2).join('/')
}

export const TerminalPaneHeader: React.FC<TerminalPaneHeaderProps> = ({
  pane,
  isActive,
  isMaximized,
  rootSessionId,
  onRestartPane,
}) => {
  const { t } = useTranslation('terminal')

  // 从 layout 获取 spaceId
  const spaceId = useTerminalSplitStore(
    state => state.layouts[rootSessionId]?.spaceId ?? '',
  )

  // 从 TerminalSessionStore 获取 session 信息
  const session = useTerminalSessionStore(state => {
    const sessions = state.sessionsBySpace[spaceId]
    return sessions?.find(s => s.id === pane.sessionId) ?? null
  })

  const paneStatus = useTerminalPaneStatusStore(
    state => state.statuses[pane.sessionId]?.status ?? 'idle',
  )
  const paneExitCode = useTerminalPaneStatusStore(
    state => state.statuses[pane.sessionId]?.exitCode,
  )

  const title = session?.title || t('title')
  const cwd = session?.cwd ? truncateCwd(session.cwd) : ''

  const handleToggleMaximize = useCallback(() => {
    useTerminalSplitStore.getState().toggleMaximize(rootSessionId, pane.id)
  }, [rootSessionId, pane.id])

  const handleSplitHorizontal = useCallback(() => {
    createSplitPane({
      rootSessionId,
      targetPaneId: pane.id,
      direction: 'horizontal',
      side: 'right',
      spaceId,
      defaultTitle: t('title'),
      inheritFromSessionId: pane.sessionId,
    })
  }, [rootSessionId, pane.id, pane.sessionId, spaceId, t])

  const handleSplitVertical = useCallback(() => {
    createSplitPane({
      rootSessionId,
      targetPaneId: pane.id,
      direction: 'vertical',
      side: 'bottom',
      spaceId,
      defaultTitle: t('title'),
      inheritFromSessionId: pane.sessionId,
    })
  }, [rootSessionId, pane.id, pane.sessionId, spaceId, t])

  const handleClose = useCallback(() => {
    closeSplitPane({
      rootSessionId,
      paneId: pane.id,
      sessionId: pane.sessionId,
      spaceId,
    })
  }, [rootSessionId, pane.id, pane.sessionId, spaceId])

  const handleRestart = useCallback(() => {
    onRestartPane?.(pane.sessionId)
  }, [pane.sessionId, onRestartPane])

  return (
    <div
      className={cn(
        'group/header flex h-7 flex-shrink-0 items-center justify-between',
        'border-b border-border bg-muted px-2',
        'select-none',
      )}
    >
      {/* 左侧：状态指示器 + 标题 + cwd + 退出码 */}
      <div className="flex min-w-0 items-center gap-1.5">
        <PaneStatusIndicator status={paneStatus} isActive={isActive} />
        <span className="truncate text-body text-foreground/80">{title}</span>
        {cwd && (
          <span className="truncate font-mono text-body text-muted-foreground/80">
            {cwd}
          </span>
        )}
        {paneStatus === 'exited' && paneExitCode != null && (
          <span
            className={cn(
              'flex-shrink-0 rounded px-1 py-px text-caption',
              paneExitCode === 0
                ? 'bg-success/15 text-success'
                : 'bg-destructive/15 text-destructive',
            )}
          >
            {paneExitCode}
          </span>
        )}
      </div>

      {/* 右侧：操作按钮（hover 时显示） */}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/header:opacity-100">
        {/* 重启（仅 exited 时显示） - ER-12 */}
        {paneStatus === 'exited' && (
          <button
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded-sm',
              'text-muted-foreground hover:bg-accent hover:text-foreground',
              'transition-colors',
            )}
            title={t('restart')}
            onClick={handleRestart}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}

        {/* 最大化 / 还原 */}
        <button
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded-sm',
            'text-muted-foreground hover:bg-accent hover:text-foreground',
            'transition-colors',
          )}
          title={isMaximized ? t('split.restore') : t('split.maximize')}
          onClick={handleToggleMaximize}
        >
          {isMaximized ? (
            <Minimize2 className="h-3 w-3" />
          ) : (
            <Maximize2 className="h-3 w-3" />
          )}
        </button>

        {/* 水平分屏 */}
        {!isMaximized && (
          <button
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded-sm',
              'text-muted-foreground hover:bg-accent hover:text-foreground',
              'transition-colors',
            )}
            title={t('split.splitRight')}
            onClick={handleSplitHorizontal}
          >
            <Columns2 className="h-3 w-3" />
          </button>
        )}

        {/* 垂直分屏 */}
        {!isMaximized && (
          <button
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded-sm',
              'text-muted-foreground hover:bg-accent hover:text-foreground',
              'transition-colors',
            )}
            title={t('split.splitDown')}
            onClick={handleSplitVertical}
          >
            <Rows2 className="h-3 w-3" />
          </button>
        )}

        {/* 关闭 */}
        <button
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded-sm',
            'text-muted-foreground hover:bg-destructive/80 hover:text-destructive-foreground',
            'transition-colors',
          )}
          title={t('split.close')}
          onClick={handleClose}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}

TerminalPaneHeader.displayName = 'TerminalPaneHeader'
