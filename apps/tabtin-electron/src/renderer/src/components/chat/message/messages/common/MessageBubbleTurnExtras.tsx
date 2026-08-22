import React from 'react'
import { TurnArtifactsCard } from '../../../turn/TurnArtifactsCard'
import type { TurnArtifact } from '../../../turn/turnArtifacts'

export interface MessageBubbleTurnExtrasProps {
  sessionId?: string | null
  tabScopeKey?: string | null
  isLastInTurn: boolean
  isUser: boolean
  isMiniMessage: boolean
  isErrorEnvelope: boolean
  turnArtifacts?: TurnArtifact[]
  /** 当前轮之前的历史轮产物 */
  historyArtifacts?: TurnArtifact[]
  /** 当前会话访问权限是否允许打开响应产物。 */
  canOpenArtifacts?: boolean
}

export const MessageBubbleTurnExtras: React.FC<MessageBubbleTurnExtrasProps> = ({
  sessionId,
  tabScopeKey,
  isLastInTurn,
  isUser,
  isMiniMessage,
  isErrorEnvelope,
  turnArtifacts,
  historyArtifacts,
  canOpenArtifacts = true,
}) => {
  const showTurnScopedExtras = isLastInTurn && !isUser && !isMiniMessage && !isErrorEnvelope

  return (
    <>
      {canOpenArtifacts
        && showTurnScopedExtras
        && turnArtifacts
        && turnArtifacts.length > 0
        && sessionId && (
        <TurnArtifactsCard
          artifacts={turnArtifacts}
          historyArtifacts={historyArtifacts}
          sessionId={sessionId}
          tabScopeKey={tabScopeKey}
        />
      )}
    </>
  )
}
