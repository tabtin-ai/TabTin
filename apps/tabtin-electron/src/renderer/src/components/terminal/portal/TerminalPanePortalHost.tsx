import React, { useEffect, useRef } from 'react'
import { useTerminalPanePortalStable } from './TerminalPanePortalContext'

export interface TerminalPanePortalHostProps extends React.HTMLAttributes<HTMLDivElement> {
  sessionId: string
  onInteraction?: () => void
}

/**
 * TerminalPanePortalHost - 终端 Portal 的宿主组件
 *
 * 设计要点：
 * - 使用 useEffect，避免同步更新导致的循环
 * - 依赖数组只包含 sessionId，避免不必要的重注册
 */
export const TerminalPanePortalHost: React.FC<TerminalPanePortalHostProps> = ({
  sessionId,
  onInteraction,
  ...props
}) => {
  const { registerSlot, unregisterSlot } = useTerminalPanePortalStable()
  const divRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const element = divRef.current
    const rafId = requestAnimationFrame(() => {
      if (!mountedRef.current || !element) return
      registerSlot(sessionId, element)
    })

    return () => {
      mountedRef.current = false
      cancelAnimationFrame(rafId)
      if (element) {
        unregisterSlot(sessionId, element)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return (
    <div
      ref={divRef}
      data-terminal-pane-slot={sessionId}
      onPointerDownCapture={() => onInteraction?.()}
      onFocusCapture={() => onInteraction?.()}
      onKeyDownCapture={() => onInteraction?.()}
      {...props}
    />
  )
}

TerminalPanePortalHost.displayName = 'TerminalPanePortalHost'

