import React, { useState } from 'react'
import { cn } from '@utils/cn'
import { ApprovalAttentionDock } from '../approval/ApprovalAttentionDock'
import { ChatInputHitlPanels } from './ChatInputHitlPanels'
import { ChatInputStatusBanners } from './ChatInputStatusBanners'
import { HostPendingSendDrawer } from './HostPendingSendDrawer'
import { ChatInputModelBar } from './ChatInputModelBar'
import { ChatInputComposerSurface } from './ChatInputComposerSurface'
import { ChatInputLlmSnapshotModal } from './ChatInputLlmSnapshotModal'
import type { ChatInputChromeProps } from './chatInputTypes'

/**
 * Composer 外壳布局（对齐 release/0.0.3）：
 * 灰底托盘内 — 白底输入井在上，工作空间 + 模型底栏在下。
 */
export function ChatInputChrome(props: ChatInputChromeProps) {
  const [approvalComposer, setApprovalComposer] = useState<{
    approvalKey: string | null
    visible: boolean
  }>({ approvalKey: null, visible: false })
  const approvalKey = props.pendingApproval
    ? `${props.pendingApproval.sessionId}:${props.pendingApproval.batchId ?? props.pendingApproval.messageId ?? 'approval'}`
    : null
  const approvalComposerVisible = approvalComposer.approvalKey === approvalKey
    ? approvalComposer.visible
    : Boolean(props.hasCurrentComposerDraft)

  const approvalCanResolve = props.pendingApproval?.canResolve !== false
  const showComposer = !props.pendingApproval
    || !approvalCanResolve
    || approvalComposerVisible

  return (
    <>
      <div className={cn(
        props.composerWelcomeLayout
          ? 'flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden'
          : 'space-y-1.5',
      )}>
        <ChatInputHitlPanels
          pendingAskUser={props.pendingAskUser}
          onAskUserSubmit={props.onAskUserSubmit}
          onAskUserTextSubmit={props.onAskUserTextSubmit}
          onAskUserFieldsSubmit={props.onAskUserFieldsSubmit}
          onAskUserApprovalSubmit={props.onAskUserApprovalSubmit}
          onAskUserSkip={props.onAskUserSkip}
          isAskUserSubmitting={props.isAskUserSubmitting}
          wsDisconnected={props.wsDisconnected}
          spaceId={props.spaceId}
        />

        <ChatInputStatusBanners
          sessionTodos={props.sessionTodos}
          isStreaming={props.isStreaming}
        />

        <HostPendingSendDrawer sessionId={props.sessionId} />

        {props.pendingApproval && (
          <ApprovalAttentionDock
            key={approvalKey ?? undefined}
            approval={props.pendingApproval}
            onSubmit={props.onApprovalSubmit}
            isSubmitting={props.isApprovalSubmitting}
            onDismiss={props.onApprovalDismiss}
            composerVisible={showComposer}
            onToggleComposer={() => setApprovalComposer({
              approvalKey,
              visible: !showComposer,
            })}
          />
        )}

        {showComposer && <ChatInputComposerSurface {...props} />}

        <ChatInputModelBar
          models={props.models}
          currentModel={props.currentModel}
          onModelChange={props.onModelChange}
          canChangeModel={props.canChangeModel}
          readOnlyModelName={props.readOnlyModelName}
          currentContextTier={props.currentContextTier}
          currentModelParamOverrides={props.currentModelParamOverrides}
          disabled={props.disabled}
          isStreaming={props.isStreaming}
          isLoadingModels={props.isLoadingModels}
          modelLoadError={props.modelLoadError}
          onRetryLoadModels={props.onRetryLoadModels}
          compactModelSelector={props.compactModelSelector}
          showExecutionSpaceIndicator={props.showExecutionSpaceIndicator}
          canSwitchExecutionSpace={props.canSwitchExecutionSpace}
          executionSpaceTooltip={props.executionSpaceTooltip}
          spaceId={props.spaceId}
          spaceName={props.spaceName}
          onExecutionSpaceChange={props.onExecutionSpaceChange}
        />
      </div>

      <ChatInputLlmSnapshotModal
        sessionId={props.sessionId}
        snapshotModalOpen={props.snapshotModalOpen}
        setSnapshotModalOpen={props.setSnapshotModalOpen}
        effectiveSnapshots={props.effectiveSnapshots}
        effectiveCloudMessages={props.effectiveCloudMessages}
        cloudMessageCount={props.cloudMessageCount}
        debugAgentId={props.debugAgentId}
        debugAgentOptions={props.debugAgentOptions}
        setDebugAgentId={props.setDebugAgentId}
      />
    </>
  )
}
