import React from 'react'
import { Brain } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { BORDER, ICON_SIZE, STEP_ROW } from '../registry/chatDesignTokens'
import { STREAMING_PREVIEW_HEIGHT_PX } from '../markdown/streamingPreviewHeight'
import { ShinyText } from '../markdown/ShinyText'

export type AgentAwaitingThoughtMode = 'thinking' | 'planningNext'

/**
 * Agent 回合加载壳（设计 2026-07-13 +  + agent-motion-design）。
 * - thinking：发送后首段「思考中…」+ 66px 三段同色系骨架（chat-motion-awaiting-line）
 * - planningNext：中间步骤「正在计划下一步...」（同扫光，无骨架）
 */
export const AgentAwaitingThought: React.FC<{
  mode?: AgentAwaitingThoughtMode
}> = React.memo(({ mode = 'thinking' }) => {
  const { t } = useTranslation('chat')
  const isPlanningNext = mode === 'planningNext'
  const label = isPlanningNext
    ? t('blockTimeline.thinking.planningNext', { defaultValue: '正在计划下一步...' })
    : t('blockTimeline.thinking.streaming', { defaultValue: '思考中…' })

  return (
    <div
      className="my-0.5"
      data-testid="agent-awaiting-thought"
      data-mode={mode}
      aria-live="polite"
      aria-busy="true"
    >
      <div className={STEP_ROW.inline}>
        <Brain className={cn(ICON_SIZE.md, 'shrink-0', STEP_ROW.icon)} />
        {isPlanningNext ? (
          <ShinyText className={cn(STEP_ROW.label, 'truncate')}>{label}</ShinyText>
        ) : (
          <span className={cn(STEP_ROW.label, 'truncate')}>{label}</span>
        )}
      </div>
      {!isPlanningNext && (
        <div
          className={cn('relative mt-1 ml-3 overflow-hidden border-l pl-2', BORDER.subtle)}
          style={{ height: STREAMING_PREVIEW_HEIGHT_PX }}
          data-testid="agent-awaiting-thought-preview"
        >
          {/* 三段同色系骨架；breathe + stagger 由共享 CSS `.chat-motion-awaiting-line` 提供 */}
          <div className="flex h-full flex-col justify-end gap-1.5 py-1">
            <div className="chat-motion-awaiting-line h-2 w-[64%] rounded-sm bg-muted/60" />
            <div className="chat-motion-awaiting-line h-2 w-[82%] rounded-sm bg-muted/60" />
            <div className="chat-motion-awaiting-line h-2 w-[47%] rounded-sm bg-muted/60" />
          </div>
        </div>
      )}
    </div>
  )
})
AgentAwaitingThought.displayName = 'AgentAwaitingThought'
