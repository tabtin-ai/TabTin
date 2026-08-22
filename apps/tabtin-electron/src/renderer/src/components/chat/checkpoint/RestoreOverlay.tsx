/**
 * RestoreOverlay — 检查点恢复进度遮罩
 *
 * 在 isRestoring 时显示半透明遮罩 + 分步文案，禁止用户操作。
 *
 * 支持两种模式：
 * 1. 传入 sessionId — 仅在该 session 正在恢复时显示（分屏场景）
 * 2. 不传 sessionId — 只要有任何 session 在恢复就显示（主面板场景）
 */

import React, { useState, useEffect, useCallback } from 'react'
import { RotateCcw } from 'lucide-react'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../../stores/chat/useChatStore'
import type { RestoringPhase } from '../../../stores/chat/checkpoint/slices/checkpointSlice'
import { abortActiveRollback } from '../../../stores/chat/checkpoint/slices/checkpointSlice'

interface RestoreOverlayProps {
  sessionId?: string
}

const PHASE_ORDER: RestoringPhase[] = ['preparing', 'files', 'resources', 'finalizing']

const CANCEL_THRESHOLD_SECONDS = 5
const LONG_WAIT_THRESHOLD_SECONDS = 15
const FORCE_CANCEL_THRESHOLD_SECONDS = 30

const PHASE_I18N: Record<RestoringPhase, { titleKey: string; titleDefault: string; hintKey: string; hintDefault: string }> = {
  preparing:  { titleKey: 'checkpoint.restoringPreparing',   titleDefault: '正在准备...',     hintKey: 'checkpoint.restoringPreparingHint',   hintDefault: '正在准备回退' },
  files:      { titleKey: 'checkpoint.restoringFiles',       titleDefault: '正在恢复文件...', hintKey: 'checkpoint.restoringFilesHint',       hintDefault: '正在回退文件到目标版本' },
  resources:  { titleKey: 'checkpoint.restoringResources',   titleDefault: '正在恢复资源...', hintKey: 'checkpoint.restoringResourcesHint',   hintDefault: '正在恢复表格、文档等资源' },
  finalizing: { titleKey: 'checkpoint.restoringFinalizing',  titleDefault: '即将完成...',     hintKey: 'checkpoint.restoringFinalizingHint',  hintDefault: '正在整理对话记录' },
}

export const RestoreOverlay: React.FC<RestoreOverlayProps> = ({ sessionId }) => {
  const restoringSessionId = useChatStore(s => s.restoringSessionId)
  const restoringPhase = useChatStore(s => s.restoringPhase)
  const { t } = useTranslation('chat')

  const isRestoring = sessionId
    ? restoringSessionId === sessionId
    : restoringSessionId != null

  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    if (!isRestoring) {
      setElapsedSeconds(0)
      return
    }
    const timer = setInterval(() => setElapsedSeconds(prev => prev + 1), 1000)
    return () => clearInterval(timer)
  }, [isRestoring])

  const handleCancel = useCallback(() => {
    const sid = useChatStore.getState().restoringSessionId
    abortActiveRollback()
    useChatStore.setState(state => ({
      restoringSessionId: null,
      restoringPhase: null,
      ...(sid ? { restoreInterruptedBySessionId: { ...state.restoreInterruptedBySessionId, [sid]: true } } : {}),
    }))
  }, [])

  if (!isRestoring) return null

  const phase = restoringPhase && PHASE_I18N[restoringPhase]
  const stepIndex = restoringPhase ? PHASE_ORDER.indexOf(restoringPhase) : -1
  const stepLabel = stepIndex >= 0 ? `(${stepIndex + 1}/${PHASE_ORDER.length})` : ''
  const title = phase
    ? t(phase.titleKey, { defaultValue: phase.titleDefault })
    : t('checkpoint.restoring', { defaultValue: '正在恢复...' })
  const hint = phase
    ? t(phase.hintKey, { defaultValue: phase.hintDefault })
    : t('checkpoint.restoringHint', { defaultValue: '正在回退对话和文件状态' })

  const showLongWaitWarning = elapsedSeconds >= LONG_WAIT_THRESHOLD_SECONDS
  const showForceCancel = elapsedSeconds >= FORCE_CANCEL_THRESHOLD_SECONDS

  return (
    <div className="absolute inset-0 z-modal flex items-center justify-center overlay-backdrop-blur">
      <div className={`flex flex-col items-center gap-3 rounded-interactive px-8 py-6 ${OVERLAY_SURFACE_CLASS}`}>
        <RotateCcw className="h-6 w-6 animate-spin text-primary" />
        <span className="text-body font-medium text-foreground">
          {title} {stepLabel && <span className="text-muted-foreground/80">{stepLabel}</span>}
        </span>
        <span className="text-body text-muted-foreground">
          {hint}
        </span>
        {showLongWaitWarning && (
          <span className="text-caption font-medium text-warning mt-1">
            {t('checkpoint.restoringLongWait', { defaultValue: '恢复时间较长，可能遇到问题' })}
          </span>
        )}
        <span className="text-caption text-muted-foreground/60 mt-1">
          {t('checkpoint.restoringElapsed', { defaultValue: '已用时 {{seconds}} 秒', seconds: elapsedSeconds })}
        </span>
        {elapsedSeconds >= CANCEL_THRESHOLD_SECONDS && !showForceCancel && (
          <button
            onClick={handleCancel}
            className="text-caption text-muted-foreground/80 hover:text-foreground underline mt-1 cursor-pointer"
          >
            {t('checkpoint.cancelRestore', { defaultValue: '取消恢复' })}
          </button>
        )}
        {showForceCancel && (
          <button
            onClick={handleCancel}
            className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-destructive/30 px-3 py-1.5 text-body font-medium text-destructive hover:bg-destructive/5 transition-colors cursor-pointer"
          >
            {t('checkpoint.forceCancel', { defaultValue: '强制取消' })}
          </button>
        )}
      </div>
    </div>
  )
}
