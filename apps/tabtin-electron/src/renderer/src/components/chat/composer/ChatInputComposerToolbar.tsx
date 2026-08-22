import React from 'react'
import {
  AlertTriangle,
  Mic,
  Sparkles,
  Code2,
} from 'lucide-react'
import { toast } from '@components/ui'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { AgentModeSelector } from '../model/AgentModeSelector'
import { GroupTeamConfigButton } from '../model/GroupTeamConfigButton'
import { ApprovalGrantPopover } from '../approval/ApprovalGrantPopover'
import { VoiceRecordingCapsule } from '../voice/VoiceRecordingCapsule'
import { PresetPickerPopover } from '../composer-presets/PresetPickerPopover'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { formatShortcut } from '@/stores/useVoiceSettingsStore'
import { FILE_LIMITS } from '../types'
import { COMPOSER_TOOLBAR_BUTTON, COMPOSER_TOOLBAR_ICON_CLASS, COMPOSER_TOOLBAR_ICON_STROKE } from '../registry/chatDesignTokens'
import { ChatInputSendControls } from './ChatInputSendControls'
import { ComposerAddMenu } from './ComposerAddMenu'
import type { ChatInputChromeProps } from './chatInputTypes'

type ToolbarProps = Pick<
  ChatInputChromeProps,
  | 'toolbarRef'
  | 'compactLeft'
  | 'compactModelSelector'
  | 'agentMode'
  | 'setAgentMode'
  | 'enableAgentPicker'
  | 'canChangeAgent'
  | 'draftScopeKey'
  | 'showAgentIdentity'
  | 'disabled'
  | 'isStreaming'
  | 'spaceId'
  | 'sessionId'
  | 'showLlmSnapshotButton'
  | 'setSnapshotModalOpen'
  | 'handleFileSelect'
  | 'attachments'
  | 'slashOptions'
  | 'slashOpen'
  | 'mentionOpen'
  | 'input'
  | 'setInput'
  | 'textareaRef'
  | 'chipContextRefs'
  | 'onAddContextRef'
  | 'onRemoveContextRef'
  | 'showAddMenu'
  | 'closeSkillSlash'
  | 'setMentionOpen'
  | 'voiceEnabled'
  | 'isVoiceActive'
  | 'voiceState'
  | 'voice'
  | 'micGate'
  | 'voiceShortcut'
  | 'handleMicPreconnect'
  | 'handleMicClick'
  | 'wsDisconnected'
  | 'hasAvailablePresets'
  | 'presetBtnRef'
  | 'presetPickerOpen'
  | 'setPresetPickerOpen'
  | 'resolvedPresetScopeId'
  | 'queueCount'
  | 'isSendInFlight'
  | 'ringContextWindow'
  | 'tokenUsage'
  | 'input'
  | 'handleStop'
  | 'isSendCoolingDown'
  | 'canSendMessage'
  | 'handleSend'
  | 'handleInterruptLatest'
  | 'isManualCompacting'
>

type ToolbarCollapseStage = 0 | 1 | 2

function useToolbarCollapseStage(forceCompact: boolean) {
  const [controls, setControls] = React.useState<HTMLDivElement | null>(null)
  const [stage, setStage] = React.useState<ToolbarCollapseStage>(forceCompact ? 2 : 0)
  const [measurementRevision, setMeasurementRevision] = React.useState(0)
  const lastWidthRef = React.useRef(0)
  const controlsRef = React.useCallback((element: HTMLDivElement | null) => {
    setControls(element)
  }, [])

  React.useLayoutEffect(() => {
    if (!controls) return
    if (forceCompact) {
      if (stage !== 2) setStage(2)
      return
    }
    if (controls.scrollWidth > controls.clientWidth + 1 && stage < 2) {
      setStage((stage + 1) as ToolbarCollapseStage)
    }
  }, [controls, forceCompact, measurementRevision, stage])

  const resetForContent = React.useCallback(() => {
    setStage(forceCompact ? 2 : 0)
    setMeasurementRevision(revision => revision + 1)
  }, [forceCompact])

  React.useEffect(() => {
    if (!controls) return
    lastWidthRef.current = controls.clientWidth
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- Composer 已位于 React Activity 子树，hidden 时 effect 自动 cleanup；此处必须观察 callback ref 对应的可见实例。
    const resizeObserver = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? controls.clientWidth
      if (Math.abs(width - lastWidthRef.current) <= 1) return
      lastWidthRef.current = width
      resetForContent()
    })
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 与上方 ResizeObserver 共用 Activity 管理的可见 Composer 生命周期，文本变化时需重新测量实际宽度。
    const mutationObserver = new MutationObserver(resetForContent)
    resizeObserver.observe(controls)
    mutationObserver.observe(controls, {
      characterData: true,
      subtree: true,
    })
    resetForContent()

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [controls, resetForContent])

  return { controlsRef, stage }
}

export function ChatInputComposerToolbar({
  toolbarRef,
  compactLeft,
  compactModelSelector,
  agentMode,
  setAgentMode,
  enableAgentPicker = false,
  canChangeAgent,
  draftScopeKey = null,
  showAgentIdentity = false,
  disabled,
  isStreaming,
  spaceId,
  sessionId,
  showLlmSnapshotButton,
  setSnapshotModalOpen,
  handleFileSelect,
  attachments,
  slashOptions,
  slashOpen,
  mentionOpen,
  input,
  setInput,
  textareaRef,
  chipContextRefs,
  onAddContextRef,
  onRemoveContextRef,
  showAddMenu = true,
  closeSkillSlash,
  setMentionOpen,
  voiceEnabled,
  isVoiceActive,
  voiceState,
  voice,
  micGate,
  voiceShortcut,
  handleMicPreconnect,
  handleMicClick,
  wsDisconnected,
  hasAvailablePresets,
  presetBtnRef,
  presetPickerOpen,
  setPresetPickerOpen,
  resolvedPresetScopeId,
  queueCount = 0,
  isSendInFlight = false,
  ringContextWindow,
  tokenUsage,
  handleStop,
  isSendCoolingDown,
  canSendMessage,
  handleSend,
  handleInterruptLatest,
  isManualCompacting,
}: ToolbarProps) {
  const { t } = useTranslation('chat')
  const { stopRecording: voiceStop, cancelRecording: voiceCancel } = voice
  const micBlocked = micGate.isDenied || micGate.isUnsupported
  const voiceErrorMessage = voice.errorMessage || t('voice.capsuleError')
  const lastVoiceErrorRef = React.useRef<string | null>(null)
  const {
    controlsRef,
    stage: toolbarCollapseStage,
  } = useToolbarCollapseStage(compactModelSelector)

  React.useEffect(() => {
    if (voiceState !== 'error') {
      lastVoiceErrorRef.current = null
      return
    }
    if (lastVoiceErrorRef.current === voiceErrorMessage) return
    lastVoiceErrorRef.current = voiceErrorMessage
    toast({
      title: voiceErrorMessage,
      variant: 'destructive',
    })
  }, [voiceErrorMessage, voiceState])

  const micControl = !voiceEnabled ? null : voiceState === 'error' ? (
    <ChatIconTooltip content={voiceErrorMessage}>
      <button
        type="button"
        onClick={voiceCancel}
        className={cn(COMPOSER_TOOLBAR_BUTTON, 'shrink-0 text-destructive')}
        aria-label={voiceErrorMessage}
      >
        <AlertTriangle
          className={COMPOSER_TOOLBAR_ICON_CLASS}
          strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE}
        />
      </button>
    </ChatIconTooltip>
  ) : isVoiceActive ? (
    <VoiceRecordingCapsule
      state={voiceState}
      audioLevels={voice.audioLevels}
      duration={voice.duration}
      onStop={voiceStop}
      onCancel={voiceCancel}
    />
  ) : (
    <ChatIconTooltip
      content={
        micGate.isUnsupported
          ? t('voice.micUnsupported', { defaultValue: '语音输入需在 Electron 客户端中使用' })
          : micGate.isDenied
            ? t('voice.micPermission')
            : `${t('voice.inputTitle')} (${formatShortcut(voiceShortcut)})`
      }
      align="start"
      collisionPadding={12}
    >
      <button
        type="button"
        onClick={handleMicClick}
        onMouseEnter={handleMicPreconnect}
        onFocus={handleMicPreconnect}
        disabled={disabled || wsDisconnected || micBlocked}
        className={cn(
          COMPOSER_TOOLBAR_BUTTON,
          'shrink-0',
          (disabled || wsDisconnected || micBlocked) && 'opacity-40 cursor-not-allowed'
        )}
        aria-label={`${t('voice.inputTitle')} (${formatShortcut(voiceShortcut)})`}
      >
        <Mic className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
      </button>
    </ChatIconTooltip>
  )

  return (
    <div ref={toolbarRef} className={cn('flex min-w-0 shrink-0 items-center justify-between gap-2 py-1.5', compactLeft ? 'pl-1 pr-2' : 'px-2')}>
      <div
        ref={controlsRef}
        data-collapse-stage={toolbarCollapseStage}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
      >
        <AgentModeSelector
          currentMode={agentMode}
          onModeChange={setAgentMode}
          sessionId={sessionId ?? null}
          enableAgentPicker={enableAgentPicker}
          canChangeAgent={canChangeAgent ?? enableAgentPicker}
          draftScopeKey={draftScopeKey}
          showAgentIdentity={showAgentIdentity}
          // ：生成中仍可换 Agent / 模式；排队消息与下一轮读新 session.agent_id。
          // 不把 isStreaming 并进 disabled（与团队配置 / 转交按钮解耦）。
          disabled={disabled}
          compact={compactModelSelector}
          compactIdentity={toolbarCollapseStage === 2}
          compactMode={toolbarCollapseStage >= 1}
        />

        <ApprovalGrantPopover
          spaceId={spaceId ?? null}
          sessionId={sessionId ?? null}
          compact={compactModelSelector || toolbarCollapseStage >= 1}
        />

        {agentMode === 'group' && spaceId && sessionId ? (
          <GroupTeamConfigButton
            spaceId={spaceId}
            sessionId={sessionId}
            disabled={disabled || isStreaming}
          />
        ) : null}

        {showLlmSnapshotButton ? (
          <ChatIconTooltip content={t('agentSteps.viewSnapshot', { defaultValue: '查看 LLM 调用入参' })}>
            <button
              type="button"
              onClick={() => setSnapshotModalOpen(true)}
              className={cn(COMPOSER_TOOLBAR_BUTTON, 'shrink-0')}
              aria-label={t('agentSteps.viewSnapshot', { defaultValue: '查看 LLM 调用入参' })}
            >
              <Code2 className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
            </button>
          </ChatIconTooltip>
        ) : null}

        {showAddMenu ? <ChatIconTooltip content={t('input.addMenu', { defaultValue: '添加附件、Skill 或 MCP' })} align="start" collisionPadding={12}>
          <ComposerAddMenu
            disabled={disabled}
            isStreaming={isStreaming}
            attachmentLimitReached={attachments.length >= FILE_LIMITS.MAX_ATTACHMENTS}
            handleFileSelect={handleFileSelect}
            slashOptions={slashOptions}
            input={input}
            setInput={setInput}
            textareaRef={textareaRef}
            sessionId={sessionId}
            slashOpen={slashOpen}
            mentionOpen={mentionOpen}
            presetPickerOpen={presetPickerOpen}
            contextRefs={chipContextRefs}
            onAddContextRef={onAddContextRef}
            onRemoveContextRef={onRemoveContextRef}
            closeSkillSlash={closeSkillSlash}
            setMentionOpen={setMentionOpen}
            setPresetPickerOpen={setPresetPickerOpen}
          />
        </ChatIconTooltip> : null}

        {micControl}

        {hasAvailablePresets && (
          <div className="relative shrink-0">
            <ChatIconTooltip content={t('input.presetPicker', 'AI 工具')}>
              <button
                ref={presetBtnRef}
                type="button"
                onClick={() => setPresetPickerOpen(prev => !prev)}
                disabled={disabled || wsDisconnected || !resolvedPresetScopeId}
                className={cn(
                  COMPOSER_TOOLBAR_BUTTON,
                  presetPickerOpen
                    ? 'bg-foreground/[0.06] text-accent-text hover:bg-foreground/[0.06] dark:bg-foreground/[0.08] dark:hover:bg-foreground/[0.08]'
                    : '',
                  (disabled || wsDisconnected || !resolvedPresetScopeId) && 'opacity-40 cursor-not-allowed'
                )}
                aria-label={t('input.presetPicker', 'AI 工具')}
              >
                <Sparkles className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
              </button>
            </ChatIconTooltip>
            {resolvedPresetScopeId && (
              <PresetPickerPopover
                open={presetPickerOpen}
                onClose={() => setPresetPickerOpen(false)}
                sessionId={sessionId}
                presetScopeId={resolvedPresetScopeId}
                anchorRef={presetBtnRef}
                spaceId={spaceId}
              />
            )}
          </div>
        )}
      </div>

      <ChatInputSendControls
        ringContextWindow={ringContextWindow}
        tokenUsage={tokenUsage}
        input={input}
        isStreaming={!!isStreaming}
        queueCount={queueCount}
        isSendInFlight={isSendInFlight}
        handleStop={handleStop}
        isSendCoolingDown={isSendCoolingDown}
        canSendMessage={canSendMessage}
        handleSend={handleSend}
        handleInterruptLatest={handleInterruptLatest}
        isManualCompacting={isManualCompacting}
        wsDisconnected={wsDisconnected}
      />

    </div>
  )
}
