import { useLayoutEffect } from 'react'
import { cn } from '@utils/cn'
import { STEP_ROW } from '../../../registry/chatDesignTokens'
import { useTurnEndLayout } from '../../../viewport/TurnEndLayoutContext'

export function useMessageBubbleTurnEndLayout(input: {
  isLastAssistantMsg: boolean
  isStreaming: boolean
  sessionPulseVisible: boolean
}): { showTurnEndSpacer: boolean } {
  const {
    phase: turnEndPhase,
    shouldHoldClosingSpacer,
    markClosingUiReady,
  } = useTurnEndLayout()
  const isTurnEndActive =
    turnEndPhase === 'committing' || turnEndPhase === 'settling'
  const showTurnEndSpacer =
    input.isLastAssistantMsg
    && !input.sessionPulseVisible
    && shouldHoldClosingSpacer

  useLayoutEffect(() => {
    if (!input.isLastAssistantMsg || input.isStreaming || !isTurnEndActive) return
    markClosingUiReady()
  }, [
    input.isLastAssistantMsg,
    input.isStreaming,
    isTurnEndActive,
    markClosingUiReady,
  ])

  return { showTurnEndSpacer }
}

export function MessageBubbleTurnEndSpacer() {
  return (
    <div
      className={cn(STEP_ROW.inline)}
      data-testid="agent-turn-end-spacer"
      aria-hidden="true"
    />
  )
}
