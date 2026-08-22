/**
 * TerminalSession - 终端会话容器
 *
 * 包装 XTerminal，提供工具栏和会话管理。
 */

import React, { useState, useCallback, useEffect } from 'react'
import { cn } from '@utils/cn'
import { XTerminal } from './XTerminal'
import { RotateCcw } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { killPtySession, useTerminalSessionStore } from '@components/context-space/sources/terminal'
import { useTerminalSplitStore } from '@stores/useTerminalSplitStore'
import { useShallow } from 'zustand/react/shallow'
import { createLogger } from '@/utils/logger'

const log = createLogger('TerminalSession')

interface TerminalSessionProps {
  sessionId: string
  mode?: 'regular' | 'sandbox'
  threadId?: string
  className?: string
  'data-terminal-session-id'?: string
  onInteraction?: () => void
}

/**
 * 从 split store 中查找包含 sessionId 的布局，判断是否多 pane。
 */
function selectIsMultiPane(
  layouts: Record<string, { panes: Record<string, { sessionId: string }> }>,
  sessionId: string,
): boolean {
  for (const layout of Object.values(layouts)) {
    const paneEntries = Object.values(layout.panes)
    if (paneEntries.some(p => p.sessionId === sessionId)) {
      return paneEntries.length > 1
    }
  }
  return false
}

/** 稳定空引用，供 useShallow 在「未找到会话」时返回，避免无限更新 */
const EMPTY_SESSION_FIELDS: { cwd: string | undefined; executionSpaceId: string | undefined } = {
  cwd: undefined,
  executionSpaceId: undefined,
}

export const TerminalSession: React.FC<TerminalSessionProps> = ({
  sessionId,
  mode: _mode,
  threadId: _threadId,
  className,
  onInteraction,
  ...rest
}) => {
  const { t } = useTranslation('terminal')
  const [isExited, setIsExited] = useState(false)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [key, setKey] = useState(0)

  // Phase 4：cwd 与 executionSpaceId 都取自会话本身（跨桶按 sessionId 定位）。
  // executionSpaceId = 真实执行 Space（对话/执行终端）或 undefined（桌面沙箱终端）——
  // 传给 XTerminal → spawn 时作为 spaceId 注入 TABTIN_SPACE_ID，桌面终端不注入。
  const { cwd: sessionCwd, executionSpaceId } = useTerminalSessionStore(
    useShallow(state => {
      for (const sessions of Object.values(state.sessionsBySpace)) {
        const found = sessions.find(s => s.id === sessionId)
        if (found) return { cwd: found.cwd, executionSpaceId: found.executionSpaceId }
      }
      return EMPTY_SESSION_FIELDS
    }),
  )

  const isMultiPane = useTerminalSplitStore(
    state => selectIsMultiPane(state.layouts, sessionId),
  )

  useEffect(() => {
    log.debug('挂载:', sessionId)
    return () => { log.debug('卸载:', sessionId) }
  }, [sessionId])

  const handleExit = useCallback((code: number) => {
    setIsExited(true)
    setExitCode(code)
  }, [])

  const handleRestart = useCallback(() => {
    const reset = () => {
      setIsExited(false)
      setExitCode(null)
      setKey(prev => prev + 1)
    }

    void killPtySession(sessionId).finally(reset)
  }, [sessionId])

  return (
    <div
      className={cn('flex flex-col h-full bg-background', className)}
      onPointerDownCapture={() => onInteraction?.()}
      onFocusCapture={() => onInteraction?.()}
      onKeyDownCapture={() => onInteraction?.()}
      {...rest}
    >
      {!isMultiPane && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted">
          <div className="flex items-center gap-2 text-body text-muted-foreground">
            <span className="font-mono">{t('title')}</span>
            {isExited && (
              <span className={cn(
                'px-1.5 py-0.5 rounded text-caption',
                exitCode === 0 ? 'bg-success/20 text-success' : 'bg-destructive/20 text-destructive'
              )}>
                {t('exitCode', { code: exitCode })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {isExited && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-body text-muted-foreground hover:text-foreground hover:bg-accent"
                onClick={handleRestart}
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                {t('restart')}
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        <XTerminal
          key={key}
          sessionId={sessionId}
          cwd={sessionCwd}
          spaceId={executionSpaceId}
          onExit={handleExit}
          className="h-full w-full"
        />
      </div>
    </div>
  )
}
