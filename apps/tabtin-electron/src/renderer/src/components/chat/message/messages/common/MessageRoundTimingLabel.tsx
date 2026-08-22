/**
 * ：debug 开关下，在助手消息 footer（「刚刚」/ credits 旁）展示本轮耗时。
 *
 * 数据源（按优先级）：
 *   1. message.metadata.round_duration_ms —— lifecycle end 写入，定格
 *   2. 本轮仍在跑且本条是最后一条 assistant —— 读 runState.startedAt 实时跳动
 *   3. 本条是最后一条 assistant 且 run 刚结束但尚未写入 metadata —— endedAt - startedAt
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Timer } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChatMessage } from '@tabtin/chat-client'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { DEBUG_PANELS_ENABLED } from '@/utils/featureFlags'
import { ChatIconTooltip } from '../../../panel/ChatIconTooltip'

const TICK_INTERVAL_MS = 100

export function formatRoundDuration(ms: number): string {
  const clamped = ms > 0 ? ms : 0
  const totalSeconds = clamped / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

function readMetadataDurationMs(metadata: ChatMessage['metadata']): number | null {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.round_duration_ms
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null
}

interface MessageRoundTimingLabelProps {
  sessionId: string | null | undefined
  message: ChatMessage
  /** 本条是否会话内最后一条 assistant——仅此时允许读 runState 做实时/刚结束回退 */
  isLastAssistantMsg?: boolean
}

export function MessageRoundTimingLabel({
  sessionId,
  message,
  isLastAssistantMsg = false,
}: MessageRoundTimingLabelProps) {
  const { t } = useTranslation('chat')

  const startedAt = useChatRuntimeStore(
    useCallback(
      (s) => (sessionId ? s.runStateBySessionId[sessionId]?.startedAt ?? null : null),
      [sessionId],
    ),
  )
  const endedAt = useChatRuntimeStore(
    useCallback(
      (s) => (sessionId ? s.runStateBySessionId[sessionId]?.endedAt ?? null : null),
      [sessionId],
    ),
  )

  const metaMs = readMetadataDurationMs(message.metadata)
  const isRunning = isLastAssistantMsg && startedAt != null && endedAt == null
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isRunning) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [isRunning, startedAt])

  if (!DEBUG_PANELS_ENABLED || message.role !== 'assistant') return null

  let elapsedMs: number | null = metaMs
  if (elapsedMs == null && isLastAssistantMsg && startedAt != null) {
    elapsedMs = isRunning ? now - startedAt : (endedAt ?? startedAt) - startedAt
  }
  if (elapsedMs == null) return null

  const tooltip = isRunning
    ? t('roundTiming.tooltipRunning', { defaultValue: '本轮进行中' })
    : t('roundTiming.tooltipDone', { defaultValue: '本轮耗时' })

  return (
    <ChatIconTooltip content={tooltip}>
      <span
        className="inline-flex shrink-0 items-center gap-0.5 text-caption tabular-nums text-muted-foreground/60"
        aria-label={tooltip}
        data-testid="message-round-timing"
      >
        <Timer className="h-3 w-3" strokeWidth={2.5} />
        {formatRoundDuration(elapsedMs)}
      </span>
    </ChatIconTooltip>
  )
}
