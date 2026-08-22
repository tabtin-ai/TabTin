import React from 'react'
import {
  Send,
  StopCircle,
  ListPlus,
  Loader2,
  Zap,
} from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { COMPOSER_TOOLBAR_ICON_CLASS, COMPOSER_TOOLBAR_ICON_STROKE, COMPOSER_TEXT_MICRO } from '../registry/chatDesignTokens'
import { useTranslation } from 'react-i18next'
import { TokenUsageRing } from '../billing/TokenUsageRing'
import { estimateTextTokens } from '@/utils/chatMessageContextUsage'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { MAX_MESSAGE_CHARS } from './chatInputConstants'
import type { ChatInputChromeProps } from './chatInputTypes'
import { computeShowComposerStopChrome } from './useChatInputDerivedSendState'

interface ChatInputSendControlsProps {
  ringContextWindow: number
  tokenUsage: ChatInputChromeProps['tokenUsage']
  input: string
  isStreaming: boolean
  queueCount: number
  /** ：等待 Host ACK 时发送钮 loading */
  isSendInFlight?: boolean
  handleStop: () => void
  isSendCoolingDown: boolean
  canSendMessage: boolean
  handleSend: () => void
  /** Host 级插队：空输入 + 有排队时打断并发送最新 */
  handleInterruptLatest?: () => void
  isManualCompacting: boolean
  wsDisconnected: boolean
}

export function ChatInputSendControls({
  ringContextWindow,
  tokenUsage,
  input,
  isStreaming,
  queueCount,
  isSendInFlight = false,
  handleStop,
  isSendCoolingDown,
  canSendMessage,
  handleSend,
  handleInterruptLatest,
  isManualCompacting,
  wsDisconnected,
}: ChatInputSendControlsProps) {
  const { t } = useTranslation('chat')
  const showStopChrome = computeShowComposerStopChrome(isStreaming, queueCount)
  const sendDisabled = !canSendMessage || isSendCoolingDown || isSendInFlight
  const canInterruptLatest = Boolean(
    handleInterruptLatest
    && isStreaming
    && queueCount > 0
    && !input.trim()
    && !isSendInFlight,
  )

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {ringContextWindow > 0 && (
        <span className="mr-1 inline-flex shrink-0">
          <TokenUsageRing
            inputTokens={tokenUsage?.inputTokens ?? 0}
            outputTokens={tokenUsage?.outputTokens ?? 0}
            contextTokens={(tokenUsage?.contextTokens ?? 0) + estimateTextTokens(input)}
            contextWindow={ringContextWindow}
            contextSource={tokenUsage?.contextSource}
            estimatedCost={tokenUsage?.estimatedCost}
            creditsConsumed={tokenUsage?.creditsConsumed}
            cacheReadTokens={tokenUsage?.cacheReadTokens}
            hasCacheReadTokens={tokenUsage?.hasCacheReadTokens}
            compactInputTokens={tokenUsage?.compactInputTokens}
            reasoningTokens={tokenUsage?.reasoningTokens}
            chargeFailed={tokenUsage?.chargeFailed}
            isByok={tokenUsage?.isByok}
            hasMixedBilling={tokenUsage?.hasMixedBilling}
          />
        </span>
      )}

      {input.length > 500 && (
        <span className={cn(COMPOSER_TEXT_MICRO, 'tabular-nums', input.length > MAX_MESSAGE_CHARS ? 'text-destructive/80' : 'text-muted-foreground/40')}>
          {input.length.toLocaleString()}{input.length > MAX_MESSAGE_CHARS && ` / ${MAX_MESSAGE_CHARS.toLocaleString()}`}
        </span>
      )}

      {showStopChrome ? (
        <div className="flex items-center gap-1.5">
          <ChatIconTooltip content={t('input.stopTitle')}>
            <Button
              onClick={handleStop}
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-interactive p-0 text-muted-foreground/60 hover:bg-destructive/5 hover:text-destructive"
              aria-label={t('input.stopTitle')}
            >
              <StopCircle className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
            </Button>
          </ChatIconTooltip>
          {canInterruptLatest ? (
            <ChatIconTooltip content={t('queue.interruptSend', { defaultValue: '插队发送（Enter）' })}>
              <Button
                onClick={handleInterruptLatest}
                disabled={isSendCoolingDown}
                size="sm"
                className="h-7 gap-1 rounded-interactive bg-warning/90 px-2.5 text-body text-warning-foreground hover:bg-warning/80 disabled:opacity-50"
                aria-label={t('queue.interrupt', { defaultValue: '插队' })}
              >
                <Zap className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
                {t('queue.interrupt', { defaultValue: '插队' })}
              </Button>
            </ChatIconTooltip>
          ) : canSendMessage || isSendInFlight ? (
            <ChatIconTooltip content={isSendInFlight
              ? t('input.sending', { defaultValue: '发送中' })
              : t('queue.enqueue')}>
              <Button
                onClick={handleSend}
                disabled={isSendCoolingDown || isSendInFlight}
                size="sm"
                className="h-7 gap-1 rounded-interactive bg-accent/80 px-2.5 text-body text-accent-foreground hover:bg-accent/60 disabled:opacity-50"
                aria-label={isSendInFlight
                  ? t('input.sending', { defaultValue: '发送中' })
                  : t('queue.enqueue')}
                aria-busy={isSendInFlight || undefined}
              >
                {isSendInFlight ? (
                  <Loader2 className={cn(COMPOSER_TOOLBAR_ICON_CLASS, 'animate-spin')} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
                ) : (
                  <ListPlus className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
                )}
                {isSendInFlight
                  ? t('input.sending', { defaultValue: '发送中' })
                  : t('queue.add')}
              </Button>
            </ChatIconTooltip>
          ) : null}
        </div>
      ) : (
        <ChatIconTooltip content={isSendInFlight
          ? t('input.sending', { defaultValue: '发送中' })
          : isManualCompacting
            ? t('agentSteps.compactionInProgress')
            : wsDisconnected
              ? t('input.wsDisconnectedSendBlocked', { defaultValue: '连接已断开，请恢复连接后再发送' })
              : t('input.sendTitle')}>
          <Button
            onClick={handleSend}
            disabled={sendDisabled}
            size="sm"
            className={cn(
              'h-7 w-7 p-0 rounded-interactive transition-[background-color,color,opacity,transform] duration-[120ms] ease-out',
              canSendMessage && !isSendCoolingDown && !isSendInFlight
                ? 'bg-accent text-accent-foreground hover:bg-accent/85 active:scale-[0.97]'
                : 'bg-muted/30 text-muted-foreground/30 cursor-default'
            )}
            aria-label={isSendInFlight
              ? t('input.sending', { defaultValue: '发送中' })
              : isManualCompacting
                ? t('agentSteps.compactionInProgress')
                : wsDisconnected
                  ? t('input.wsDisconnectedSendBlocked', { defaultValue: '连接已断开，请恢复连接后再发送' })
                  : t('input.sendTitle')}
            aria-busy={isSendInFlight || undefined}
          >
            {isSendInFlight ? (
              <Loader2 className={cn(COMPOSER_TOOLBAR_ICON_CLASS, 'animate-spin')} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
            ) : (
              <Send className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
            )}
          </Button>
        </ChatIconTooltip>
      )}
    </div>
  )
}
