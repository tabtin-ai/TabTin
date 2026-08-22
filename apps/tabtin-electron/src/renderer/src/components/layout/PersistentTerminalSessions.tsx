import React, { Activity, useEffect, useMemo, useRef } from 'react'
import { cn } from '@utils/cn'
import { TerminalSplitContainer } from '@components/terminal/TerminalSplitContainer'
import { refreshTerminalViewport } from '@components/terminal/terminalRuntime'

interface PersistentTerminalSessionsProps {
  sessionIds: string[]
  activeSessionId: string | null
  /** 已在分屏中渲染的终端 sessionId，需要排除避免重复 */
  excludeSessionIds?: Set<string>
  className?: string
}

const buildUniqueSessionIds = (sessionIds: string[]) => {
  const seen = new Set<string>()
  const result: string[] = []
  sessionIds.forEach(id => {
    if (!id || seen.has(id)) return
    seen.add(id)
    result.push(id)
  })
  return result
}

export const PersistentTerminalSessions: React.FC<PersistentTerminalSessionsProps> = ({
  sessionIds,
  activeSessionId,
  excludeSessionIds,
  className
}) => {
  const uniqueSessionIds = useMemo(() => buildUniqueSessionIds(sessionIds), [sessionIds])
  const filteredSessionIds = useMemo(() => {
    if (!excludeSessionIds || excludeSessionIds.size === 0) {
      return uniqueSessionIds
    }
    return uniqueSessionIds.filter(id => !excludeSessionIds.has(id))
  }, [excludeSessionIds, uniqueSessionIds])

  const prevActiveRef = useRef<string | null>(null)
  useEffect(() => {
    if (activeSessionId && activeSessionId !== prevActiveRef.current) {
      requestAnimationFrame(() => refreshTerminalViewport(activeSessionId))
    }
    prevActiveRef.current = activeSessionId
  }, [activeSessionId])

  if (filteredSessionIds.length === 0) return null

  const hasActive = Boolean(activeSessionId && !excludeSessionIds?.has(activeSessionId))

  return (
    <div
      className={cn('absolute inset-0', className)}
      style={{ pointerEvents: hasActive ? 'auto' : 'none' }}
    >
      {filteredSessionIds.map(sessionId => {
        const isActive = sessionId === activeSessionId
        // 非 active terminal 用 `<Activity hidden>`：xterm 实例的 effect
        // cleanup（dispose 渲染、释放 ResizeObserver）。pty 输出仍在 store
        // 累积——切回来 xterm 重建并应用完整 buffer。
        return (
          <Activity key={sessionId} mode={isActive ? 'visible' : 'hidden'}>
            <div
              className="absolute inset-0"
              aria-hidden={!isActive}
              data-terminal-tab-id={sessionId}
            >
              <TerminalSplitContainer
                rootSessionId={sessionId}
                onPaneInteraction={undefined}
              />
            </div>
          </Activity>
        )
      })}
    </div>
  )
}

PersistentTerminalSessions.displayName = 'PersistentTerminalSessions'
