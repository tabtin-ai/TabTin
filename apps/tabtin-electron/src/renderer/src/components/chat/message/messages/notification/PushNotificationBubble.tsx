import React, { useMemo, useState } from 'react'
import type { ChatMessage } from '@tabtin/chat-client'
import { Ban, Check, ChevronDown, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { parsePushNotification } from '@utils/chat/pushNotificationParse'
import { buildPushSummary, pickPushSummaryTone, type PushSummaryTone } from '@utils/chat/pushNotificationSummary'
import { BG, BORDER, CARD_RADIUS, ICON_SIZE, TEXT_COLOR } from '../../../registry/chatDesignTokens'

export { isPushNotificationMessage, isSubagentCompletionPush } from '@stores/chat/presentation/messageBubble/timelineMessageVisibility'

/** 摘要三态视觉（P2-5）：成功绿 Check / 中性灰 Ban / 异常红 XCircle。 */
const PUSH_SUMMARY_TONE: Record<PushSummaryTone, { Icon: React.ComponentType<{ className?: string }>; color: string }> = {
  success: { Icon: Check, color: TEXT_COLOR.successSoft },
  neutral: { Icon: Ban, color: TEXT_COLOR.muted },
  failure: { Icon: XCircle, color: TEXT_COLOR.errorSoft },
}

export const PushNotificationBubble: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const raw = message.content ?? ''
  const parsed = useMemo(() => parsePushNotification(raw), [raw])

  // 解析失败：回落原 raw 渲染（绝不 silent 丢内容）。
  if (!parsed) {
    return (
      <div className="w-full" data-testid="push-notification-bubble">
        <div className={cn('flex items-start gap-2 px-3 py-2 border', CARD_RADIUS, BG.info, BORDER.info)}>
          <div className={cn('text-caption shrink-0 mt-0.5', TEXT_COLOR.muted)}>{t('card.system_notification', { defaultValue: '系统通知' })}</div>
          <div className={cn('flex-1 min-w-0 whitespace-pre-wrap break-words font-mono text-caption', TEXT_COLOR.secondary)}>{raw}</div>
        </div>
      </div>
    )
  }

  const tone = pickPushSummaryTone(parsed)
  const { Icon: SummaryIcon, color: summaryColor } = PUSH_SUMMARY_TONE[tone]
  const summary = buildPushSummary(parsed, t)

  // 单任务时摘要已自足（命令 + 完成/已停止/失败原因），无需展开；多任务才提供
  // 逐条干净明细。**绝不**展示面向 LLM 的原始 <task-notification> XML（session-id /
  // output-file 路径 / cwd / "while you were doing other work" 等技术内容）给用户。
  const isExpandable = parsed.tasks.length > 1

  return (
    <div className="w-full" data-testid="push-notification-bubble">
      <div className={cn('border', CARD_RADIUS, BG.info, BORDER.info)}>
        {isExpandable ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left"
            aria-expanded={expanded}
            data-testid="push-notification-summary"
            data-push-tone={tone}
          >
            <SummaryIcon className={cn(ICON_SIZE.status, 'shrink-0', summaryColor)} />
            <span className={cn('min-w-0 flex-1 truncate text-caption', TEXT_COLOR.secondary)}>{summary}</span>
            <ChevronDown className={cn(ICON_SIZE.status, 'shrink-0 transition-transform duration-200', TEXT_COLOR.muted, !expanded && '-rotate-90')} aria-hidden />
          </button>
        ) : (
          <div className="flex w-full items-center gap-2 px-3 py-2" data-testid="push-notification-summary" data-push-tone={tone}>
            <SummaryIcon className={cn(ICON_SIZE.status, 'shrink-0', summaryColor)} />
            <span className={cn('min-w-0 flex-1 truncate text-caption', TEXT_COLOR.secondary)}>{summary}</span>
          </div>
        )}
        {isExpandable && expanded && (
          <ul className={cn('px-3 pb-2 pt-2 space-y-1 border-t', BORDER.info)} data-testid="push-notification-detail">
            {parsed.tasks.map((task, i) => {
              const taskTone = task.outcome === 'failed' ? 'failure' : task.outcome === 'stopped' ? 'neutral' : 'success'
              const { color } = PUSH_SUMMARY_TONE[taskTone]
              // shell 优先展示 description（LLM 命令意图摘要），比裸命令可读。
              const title =
                task.description ||
                task.title ||
                (task.kind === 'shell'
                  ? t('pushNotification.unnamedCommand', {
                      defaultValue: '后台命令',
                    })
                  : t('pushNotification.subagentFallback', {
                      defaultValue: '子 Agent',
                    }))
              const outcomeLabel =
                task.outcome === 'failed'
                  ? t('pushNotification.outcomeFailed', {
                      defaultValue: '失败',
                    })
                  : task.outcome === 'stopped'
                    ? t('pushNotification.outcomeStopped', {
                        defaultValue: '已停止',
                      })
                    : t('pushNotification.outcomeDone', {
                        defaultValue: '已完成',
                      })
              return (
                <li key={i} className="flex items-center gap-2 text-caption">
                  <span className={cn('min-w-0 flex-1 truncate font-mono', TEXT_COLOR.secondary)}>{title}</span>
                  <span className={cn('shrink-0', color)}>{outcomeLabel}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

PushNotificationBubble.displayName = 'PushNotificationBubble'
