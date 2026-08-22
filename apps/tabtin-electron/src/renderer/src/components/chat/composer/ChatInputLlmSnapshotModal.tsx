import React from 'react'
import { LLMSnapshotPanel } from '../billing/LLMSnapshotPanel'
import type { ChatInputChromeProps } from './chatInputTypes'

type SnapshotModalProps = Pick<
  ChatInputChromeProps,
  | 'sessionId'
  | 'snapshotModalOpen'
  | 'setSnapshotModalOpen'
  | 'effectiveSnapshots'
  | 'effectiveCloudMessages'
  | 'cloudMessageCount'
  | 'debugAgentId'
  | 'debugAgentOptions'
  | 'setDebugAgentId'
>

export function ChatInputLlmSnapshotModal({
  sessionId,
  snapshotModalOpen,
  setSnapshotModalOpen,
  effectiveSnapshots,
  effectiveCloudMessages,
  cloudMessageCount,
  debugAgentId,
  debugAgentOptions,
  setDebugAgentId,
}: SnapshotModalProps) {
  if (!sessionId) return null

  return (
    <LLMSnapshotPanel
      open={snapshotModalOpen}
      onOpenChange={setSnapshotModalOpen}
      snapshots={effectiveSnapshots}
      cloudMessages={effectiveCloudMessages}
      localSnapshotCount={effectiveSnapshots.length}
      cloudMessageCount={debugAgentId === 'main' ? cloudMessageCount : 0}
      sessionId={sessionId}
      agentOptions={debugAgentOptions}
      selectedAgentId={debugAgentId}
      onSelectAgent={setDebugAgentId}
    />
  )
}
