/**
 * RestoredOverlay - 终端快照恢复提示浮层
 *
 * 当冷启动恢复了历史终端输出时，在终端顶部短暂显示提示。
 * 支持自动淡出消失和手动关闭。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@utils/cn'
import { History, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface RestoredOverlayProps {
  visible: boolean
  autoHideMs?: number
  onHide?: () => void
}

type Phase = 'entering' | 'visible' | 'exiting' | 'hidden'

export const RestoredOverlay: React.FC<RestoredOverlayProps> = ({
  visible,
  autoHideMs = 3000,
  onHide,
}) => {
  const { t } = useTranslation('terminal')
  const phaseRef = useRef<Phase>('hidden')
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, forceRender] = useState(0)
  const onHideRef = useRef(onHide)
  onHideRef.current = onHide

  const setPhase = useCallback((p: Phase) => {
    if (phaseRef.current === p) return
    phaseRef.current = p
    forceRender(n => n + 1)
  }, [])

  const cancelExitTimer = useCallback(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current)
      exitTimerRef.current = null
    }
  }, [])

  const startExit = useCallback(() => {
    if (phaseRef.current === 'exiting' || phaseRef.current === 'hidden') return
    cancelExitTimer()
    setPhase('exiting')
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null
      setPhase('hidden')
      onHideRef.current?.()
    }, 200)
  }, [setPhase, cancelExitTimer])

  useEffect(() => {
    cancelExitTimer()
    if (!visible) {
      if (phaseRef.current !== 'hidden') startExit()
      return cancelExitTimer
    }
    setPhase('entering')
    const enterTimer = setTimeout(() => setPhase('visible'), 20)
    const hideTimer = setTimeout(startExit, autoHideMs)
    return () => {
      clearTimeout(enterTimer)
      clearTimeout(hideTimer)
      cancelExitTimer()
    }
  }, [visible, autoHideMs, startExit, setPhase, cancelExitTimer])

  const phase = phaseRef.current
  if (phase === 'hidden') return null

  return (
    <div
      className={cn(
        'absolute top-2 left-1/2 -translate-x-1/2 z-sticky',
        'flex items-center gap-1.5 rounded-md pl-3 pr-1.5 py-1.5',
        'bg-muted/90 text-muted-foreground text-caption backdrop-blur-sm',
        'shadow-sm border border-border/60',
        'transition-all duration-200 ease-out',
        (phase === 'entering' || phase === 'exiting') && 'opacity-0 -translate-y-1',
        phase === 'visible' && 'opacity-100 translate-y-0',
      )}
    >
      <History className="h-3 w-3 shrink-0" />
      <span>{t('restore.title')}</span>
      <button
        className="ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        onClick={startExit}
        aria-label={t('restore.dismiss', { defaultValue: 'Dismiss' })}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

RestoredOverlay.displayName = 'RestoredOverlay'
