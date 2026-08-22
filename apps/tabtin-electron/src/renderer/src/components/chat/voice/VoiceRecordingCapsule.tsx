/**
 * VoiceRecordingCapsule — 工具栏内联语音录制胶囊
 *
 * 替代全屏弹窗，在工具栏 Mic 按钮原位展开为胶囊形状：
 * [🔴 ~~waves~~ 0:12 ■]
 *
 * 设计语言豁免：录音红是动作色（与"危险"语义不同），全应用所有"录音中"指示
 * 都用 red-500，跟主题切换无关——这是产品行为约定，不是普通的 UI 警示色。
 */
/* eslint-disable tabtin/no-chat-design-violations -- 录音红是动作色，全应用约定，不参与主题切换 */

import React, { useEffect, memo } from 'react'
import { Square, Loader2, X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { AudioLevelVisualization } from './AudioLevelVisualization'
import {
  MAX_DURATION,
  type VoiceRecordingState,
} from './useVoiceRecording'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

interface VoiceRecordingCapsuleProps {
  state: VoiceRecordingState
  audioLevels: number[]
  duration: number
  onStop: () => void
  onCancel: () => void
}

const NEAR_LIMIT_THRESHOLD = 15

export const VoiceRecordingCapsule: React.FC<VoiceRecordingCapsuleProps> = memo(({
  state,
  audioLevels,
  duration,
  onStop,
  onCancel,
}) => {
  const { t } = useTranslation('chat')
  const formattedDuration = `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`
  const isNearLimit = MAX_DURATION - duration <= NEAR_LIMIT_THRESHOLD
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [onCancel])

  return (
    <AnimatePresence mode="wait">
      {state === 'preparing' && (
        <motion.div
          key="preparing"
          initial={{ width: 28, opacity: 0.6 }}
          animate={{ width: 'auto', opacity: 1 }}
          exit={{ width: 28, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          role="status"
          aria-label={t('voice.connecting')}
          className={cn(
            'flex items-center gap-1.5 h-7 px-2 rounded-[14px]',
            'bg-red-500/10 border border-red-500/20',
          )}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin text-red-400 shrink-0" />
          <ChatIconTooltip content={t('voice.cancel')}>
            <button
              type="button"
              onClick={onCancel}
              className="flex items-center justify-center h-4 w-4 rounded-full text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
              aria-label={t('voice.cancel')}
            >
              <X className="h-3 w-3" />
            </button>
          </ChatIconTooltip>
        </motion.div>
      )}

      {state === 'recording' && (
        <motion.div
          key="recording"
          initial={{ width: 28, opacity: 0, borderRadius: 8 }}
          animate={{ width: 'auto', opacity: 1, borderRadius: 14 }}
          exit={{ width: 28, opacity: 0, borderRadius: 8 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          role="status"
          aria-label={t('voice.recording')}
          aria-live="polite"
          className={cn(
            'flex items-center gap-1.5 h-7 px-2',
            'bg-red-500/10 border border-red-500/20 rounded-[14px]',
          )}
        >
          <span className="inline-flex h-[6px] w-[6px] rounded-full bg-red-500 animate-pulse shrink-0" />

          <AudioLevelVisualization levels={audioLevels} compact />

          <span
            className={cn(
              'text-caption font-mono tabular-nums shrink-0',
              isNearLimit ? 'text-destructive' : 'text-muted-foreground/60',
            )}
          >
            {formattedDuration}
          </span>

          <ChatIconTooltip content={t('voice.capsuleStop')}>
            <button
              type="button"
              onClick={onStop}
              className="flex items-center justify-center h-5 w-5 rounded-md bg-red-500 text-white hover:bg-red-600 transition-colors shrink-0"
              aria-label={t('voice.capsuleStop')}
            >
              <Square className="h-2.5 w-2.5 fill-current" />
            </button>
          </ChatIconTooltip>
        </motion.div>
      )}
    </AnimatePresence>
  )
})

VoiceRecordingCapsule.displayName = 'VoiceRecordingCapsule'
