import React, { useMemo, useState } from 'react'
import { AtSign } from 'lucide-react'
import { cn } from '@utils/cn'
import { COMPOSER_TEXT_BODY, COMPOSER_TEXT_META, COMPOSER_TEXTAREA_MAX_HEIGHT, COMPOSER_TEXTAREA_MIN_HEIGHT } from '../registry/chatDesignTokens'
import { useTranslation } from 'react-i18next'
import { MentionPopover } from './MentionPopover'
import { SkillSlashCommandPopover } from '../skill/SkillSlashCommandPopover'
import { resolveComposerSkillTokenHighlights } from '../skill/skillSlashCommand'
import { ComposerSkillTokenHighlightOverlay } from './ComposerSkillTokenHighlight'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { useCurrentAgentDisplayName } from '../model/useCurrentAgentDisplayName'
import { resolveChatInputPlaceholder } from './resolveChatInputPlaceholder'
import type { ChatInputChromeProps } from './chatInputTypes'

type TextareaSectionProps = Pick<
  ChatInputChromeProps,
  | 'mentionOpen'
  | 'mentionQuery'
  | 'handleMentionSelect'
  | 'setMentionOpen'
  | 'textareaRef'
  | 'sessionId'
  | 'spaceId'
  | 'spaceName'
  | 'tabScopeKey'
  | 'fieldTableId'
  | 'fieldTableName'
  | 'slashOpen'
  | 'slashQuery'
  | 'slashOptions'
  | 'slashCatalog'
  | 'slashActiveIndex'
  | 'setSlashActiveIndex'
  | 'handleSkillSlashSelect'
  | 'input'
  | 'handleInput'
  | 'handleKeyDown'
  | 'handlePaste'
  | 'isVoiceActive'
  | 'agentGatewayStatus'
  | 'isStreaming'
  | 'disabled'
  | 'disabledReason'
  | 'pendingApproval'
  | 'pendingAskUser'
  | 'agentMode'
  | 'compactLeft'
  | 'contextDisplay'
  | 'composerWelcomeLayout'
>

export function ChatInputComposerTextarea({
  mentionOpen,
  mentionQuery,
  handleMentionSelect,
  setMentionOpen,
  textareaRef,
  sessionId,
  spaceId,
  spaceName,
  tabScopeKey,
  fieldTableId,
  fieldTableName,
  slashOpen,
  slashQuery,
  slashOptions,
  slashCatalog,
  slashActiveIndex,
  setSlashActiveIndex,
  handleSkillSlashSelect,
  input,
  handleInput,
  handleKeyDown,
  handlePaste,
  isVoiceActive,
  agentGatewayStatus,
  isStreaming,
  disabled,
  disabledReason,
  pendingApproval,
  pendingAskUser,
  agentMode,
  compactLeft,
  contextDisplay,
  composerWelcomeLayout = false,
}: TextareaSectionProps) {
  const { t } = useTranslation('chat')
  const agentDisplayName = useCurrentAgentDisplayName(sessionId ?? null)
  const [textareaScrollTop, setTextareaScrollTop] = useState(0)
  const skillTokenHighlights = useMemo(
    () => resolveComposerSkillTokenHighlights(input, slashCatalog),
    [input, slashCatalog],
  )
  const hasSkillTokenHighlight = skillTokenHighlights.length > 0
  const textareaSurfaceClassName = cn(
    COMPOSER_TEXT_BODY,
    composerWelcomeLayout
      ? cn(COMPOSER_TEXTAREA_MIN_HEIGHT.welcome, COMPOSER_TEXTAREA_MAX_HEIGHT.welcome, 'py-4 px-4')
      : compactLeft
        ? cn(COMPOSER_TEXTAREA_MIN_HEIGHT.compact, COMPOSER_TEXTAREA_MAX_HEIGHT.compact, 'py-2 pl-2 pr-3')
        : cn(COMPOSER_TEXTAREA_MIN_HEIGHT.panel, COMPOSER_TEXTAREA_MAX_HEIGHT.panel, 'py-3 px-3'),
  )

  return (
    <>
      <div
        className={cn(
          'relative',
          composerWelcomeLayout && cn('shrink-0', COMPOSER_TEXTAREA_MIN_HEIGHT.welcome),
        )}
      >
        <MentionPopover
          open={mentionOpen}
          query={mentionQuery}
          onSelect={handleMentionSelect}
          onClose={() => setMentionOpen(false)}
          anchorEl={textareaRef.current}
          spaceId={spaceId}
          spaceName={spaceName}
          tabScopeKey={tabScopeKey}
          fieldTableId={fieldTableId}
          fieldTableName={fieldTableName}
        />

        <SkillSlashCommandPopover
          open={slashOpen && !mentionOpen}
          query={slashQuery}
          options={slashOptions}
          activeIndex={slashActiveIndex}
          onActiveIndexChange={setSlashActiveIndex}
          onSelect={handleSkillSlashSelect}
          anchorEl={textareaRef.current}
        />

        {hasSkillTokenHighlight && (
          <ComposerSkillTokenHighlightOverlay
            value={input}
            highlights={skillTokenHighlights}
            surfaceClassName={textareaSurfaceClassName}
            scrollTop={textareaScrollTop}
          />
        )}

        <textarea
          ref={textareaRef}
          data-chat-input-textarea="true"
          data-session-id={sessionId ?? ''}
          data-space-id={spaceId ?? ''}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onScroll={(event) => setTextareaScrollTop(event.currentTarget.scrollTop)}
          readOnly={isVoiceActive}
          placeholder={resolveChatInputPlaceholder({
            t,
            agentGatewayStatus,
            isStreaming: !!isStreaming,
            disabled: !!disabled,
            disabledReason: disabledReason ?? null,
            isVoiceActive,
            pendingApproval: !!pendingApproval,
            pendingAskUser: !!pendingAskUser,
            agentMode,
            agentDisplayName,
          })}
          disabled={disabled}
          className={cn(
            'relative w-full resize-none bg-transparent',
            textareaSurfaceClassName,
            hasSkillTokenHighlight && 'caret-foreground text-transparent selection:bg-accent/25',
            'appearance-none placeholder:text-muted-foreground/50 placeholder:select-none focus:outline-none focus-visible:outline-none',
            'border-0 focus:border-0 focus:ring-0 focus:shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-none'
          )}
          rows={1}
        />
      </div>

      {contextDisplay && (
        <div
          className={cn(
            'absolute bottom-8 flex min-w-0 justify-end',
            compactLeft ? 'left-3 right-3' : 'left-4 right-3',
          )}
        >
          <ChatIconTooltip
            content={
              <span className="block max-w-[24rem] break-words text-left leading-snug">
                {contextDisplay.name
                  ? `${t('panel.contextPrefix', { label: contextDisplay.label })} · ${contextDisplay.name}`
                  : t('panel.contextPrefix', { label: contextDisplay.label })}
              </span>
            }
            align="end"
          >
            <div
              aria-label={contextDisplay.name ? `${contextDisplay.label} · ${contextDisplay.name}` : contextDisplay.label}
              className="flex min-w-0 max-w-[12rem] items-center gap-1 rounded-md select-none"
            >
              <AtSign className="h-2.5 w-2.5 shrink-0 text-muted-foreground/70" strokeWidth={2.5} />
              <span
                title={contextDisplay.name ?? contextDisplay.label}
                className={cn('min-w-0 truncate', COMPOSER_TEXT_META)}
              >
                {contextDisplay.name ?? contextDisplay.label}
              </span>
            </div>
          </ChatIconTooltip>
        </div>
      )}
    </>
  )
}
