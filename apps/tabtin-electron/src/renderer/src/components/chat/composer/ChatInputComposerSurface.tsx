import React from 'react'
import { cn } from '@utils/cn'
import { COMPOSER_SURFACE } from '../registry/chatDesignTokens'
import { ChatInputComposerDraftSections } from './ChatInputComposerDraftSections'
import { ChatInputComposerTextarea } from './ChatInputComposerTextarea'
import { ChatInputComposerToolbar } from './ChatInputComposerToolbar'
import type { ChatInputChromeProps } from './chatInputTypes'

type ComposerSurfaceProps = ChatInputChromeProps

export function ChatInputComposerSurface(props: ComposerSurfaceProps) {
  const {
    handleDragOver,
    handleDragLeave,
    handleDrop,
    disabled,
    isDragOver,
    compactLeft,
    fileInputRef,
    acceptTypes,
    handleFileInputChange,
  } = props

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-onboarding-target="new-user-organization-agent-chat"
      className={cn(
        COMPOSER_SURFACE,
        props.composerWelcomeLayout && 'flex min-h-0 flex-1 flex-col overflow-hidden',
        disabled && 'opacity-50 pointer-events-none',
        isDragOver && 'chat-composer-drag-state'
      )}
    >
      <div className={cn(
        props.composerWelcomeLayout
          ? 'min-h-0 shrink overflow-y-auto overscroll-contain'
          : 'contents',
      )}>
        <ChatInputComposerDraftSections
          compactLeft={compactLeft}
          resolvedPresetScopeId={props.resolvedPresetScopeId}
          disabled={disabled}
          replyTarget={props.replyTarget}
          sessionId={props.sessionId}
          pendingInterruptedMessage={props.pendingInterruptedMessage}
          hasCurrentComposerDraft={props.hasCurrentComposerDraft}
          handleRestoreInterruptedMessage={props.handleRestoreInterruptedMessage}
          handleDiscardInterruptedMessage={props.handleDiscardInterruptedMessage}
          conversationReferenceRefs={props.conversationReferenceRefs}
          onRemoveContextRef={props.onRemoveContextRef}
          chipContextRefs={props.chipContextRefs}
          hasAttachments={props.hasAttachments}
          attachments={props.attachments}
          removeAttachment={props.removeAttachment}
          isUploadingAttachments={props.isUploadingAttachments}
          uploadProgress={props.uploadProgress}
          handleCancelUpload={props.handleCancelUpload}
          isDragOver={isDragOver}
        />
      </div>

      <ChatInputComposerTextarea
        mentionOpen={props.mentionOpen}
        mentionQuery={props.mentionQuery}
        handleMentionSelect={props.handleMentionSelect}
        setMentionOpen={props.setMentionOpen}
        textareaRef={props.textareaRef}
        sessionId={props.sessionId}
        spaceId={props.spaceId}
        spaceName={props.spaceName}
        tabScopeKey={props.tabScopeKey}
        fieldTableId={props.fieldTableId}
        fieldTableName={props.fieldTableName}
        slashOpen={props.slashOpen}
        slashQuery={props.slashQuery}
        slashOptions={props.slashOptions}
        slashCatalog={props.slashCatalog}
        slashActiveIndex={props.slashActiveIndex}
        setSlashActiveIndex={props.setSlashActiveIndex}
        handleSkillSlashSelect={props.handleSkillSlashSelect}
        input={props.input}
        handleInput={props.handleInput}
        handleKeyDown={props.handleKeyDown}
        handlePaste={props.handlePaste}
        isVoiceActive={props.isVoiceActive}
        agentGatewayStatus={props.agentGatewayStatus}
        isStreaming={props.isStreaming}
        disabled={disabled}
        disabledReason={props.disabledReason}
        pendingApproval={props.pendingApproval}
        pendingAskUser={props.pendingAskUser}
        agentMode={props.agentMode}
        compactLeft={compactLeft}
        contextDisplay={props.contextDisplay}
        composerWelcomeLayout={props.composerWelcomeLayout}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={acceptTypes}
        onChange={handleFileInputChange}
        className="hidden"
      />

      <ChatInputComposerToolbar
        toolbarRef={props.toolbarRef}
        compactLeft={compactLeft}
        compactModelSelector={props.compactModelSelector}
        agentMode={props.agentMode}
        setAgentMode={props.setAgentMode}
        enableAgentPicker={props.enableAgentPicker}
        canChangeAgent={props.canChangeAgent}
        draftScopeKey={props.draftScopeKey}
        showAgentIdentity={props.showAgentIdentity}
        disabled={disabled}
        isStreaming={props.isStreaming}
        spaceId={props.spaceId}
        sessionId={props.sessionId}
        showLlmSnapshotButton={props.showLlmSnapshotButton}
        setSnapshotModalOpen={props.setSnapshotModalOpen}
        handleFileSelect={props.handleFileSelect}
        attachments={props.attachments}
        slashOptions={props.slashOptions}
        slashOpen={props.slashOpen}
        mentionOpen={props.mentionOpen}
        setInput={props.setInput}
        textareaRef={props.textareaRef}
        chipContextRefs={props.chipContextRefs}
        onAddContextRef={props.onAddContextRef}
        onRemoveContextRef={props.onRemoveContextRef}
        showAddMenu={props.showAddMenu}
        closeSkillSlash={props.closeSkillSlash}
        setMentionOpen={props.setMentionOpen}
        voiceEnabled={props.voiceEnabled}
        isVoiceActive={props.isVoiceActive}
        voiceState={props.voiceState}
        voice={props.voice}
        micGate={props.micGate}
        voiceShortcut={props.voiceShortcut}
        handleMicPreconnect={props.handleMicPreconnect}
        handleMicClick={props.handleMicClick}
        wsDisconnected={props.wsDisconnected}
        hasAvailablePresets={props.hasAvailablePresets}
        presetBtnRef={props.presetBtnRef}
        presetPickerOpen={props.presetPickerOpen}
        setPresetPickerOpen={props.setPresetPickerOpen}
        resolvedPresetScopeId={props.resolvedPresetScopeId}
        queueCount={props.queueCount}
        isSendInFlight={props.isSendInFlight}
        ringContextWindow={props.ringContextWindow}
        tokenUsage={props.tokenUsage}
        input={props.input}
        handleStop={props.handleStop}
        isSendCoolingDown={props.isSendCoolingDown}
        canSendMessage={props.canSendMessage}
        handleSend={props.handleSend}
        handleInterruptLatest={props.handleInterruptLatest}
        isManualCompacting={props.isManualCompacting}
      />
    </div>
  )
}
