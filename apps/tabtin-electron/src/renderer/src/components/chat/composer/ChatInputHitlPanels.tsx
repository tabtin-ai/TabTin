import React from 'react'
import { AskUserPanel } from '../ask-user/AskUserPanel'
import type { ChatInputChromeProps } from './chatInputTypes'

type HitlPanelProps = Pick<
  ChatInputChromeProps,
  | 'pendingAskUser'
  | 'onAskUserSubmit'
  | 'onAskUserTextSubmit'
  | 'onAskUserFieldsSubmit'
  | 'onAskUserApprovalSubmit'
  | 'onAskUserSkip'
  | 'isAskUserSubmitting'
  | 'wsDisconnected'
  | 'spaceId'
>

export function ChatInputHitlPanels({
  pendingAskUser,
  onAskUserSubmit,
  onAskUserTextSubmit,
  onAskUserFieldsSubmit,
  onAskUserApprovalSubmit,
  onAskUserSkip,
  isAskUserSubmitting,
  wsDisconnected,
  spaceId,
}: HitlPanelProps) {
  return (
    <>
      {pendingAskUser && (
        <AskUserPanel
          key={`${pendingAskUser.sessionId}:${pendingAskUser.interruptId ?? pendingAskUser.messageId}`}
          state={pendingAskUser}
          spaceId={spaceId}
          isSubmitting={isAskUserSubmitting}
          disabled={wsDisconnected}
          onSkip={onAskUserSkip}
          onChoiceSubmit={onAskUserSubmit ?? (() => {})}
          onFormFieldsSubmit={onAskUserFieldsSubmit}
          onFormTextSubmit={onAskUserTextSubmit}
          onApprovalSubmit={onAskUserApprovalSubmit}
        />
      )}
    </>
  )
}
