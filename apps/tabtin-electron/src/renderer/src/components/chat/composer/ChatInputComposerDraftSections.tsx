import React, { useState } from 'react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@/stores/chat/useChatStore'
import { ComposerPresetCardList } from '../composer-presets/ComposerPresetCard'
import { ReplyQuoteBar } from './ReplyQuoteBar'
import { ConversationReferenceCard } from '../context/ConversationReferenceCard'
import { ConversationReferenceViewerDialog } from '../context/ConversationReferenceViewerDialog'
import {
  conversationReferenceDisplayFromContextRef,
  type ConversationReferenceDisplay,
} from '@utils/chat/conversationReference'
import { ContextChipList } from '../context/ContextChip'
import { AttachmentPreview } from './AttachmentPreview'
import { Loader2, X, Image as ImageIcon } from 'lucide-react'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { COMPOSER_TEXT_META, COMPOSER_TEXT_META_BASE, COMPOSER_TEXT_MICRO } from '../registry/chatDesignTokens'
import type { ChatInputChromeProps } from './chatInputTypes'

type DraftSectionsProps = Pick<
  ChatInputChromeProps,
  | 'compactLeft'
  | 'resolvedPresetScopeId'
  | 'disabled'
  | 'replyTarget'
  | 'sessionId'
  | 'pendingInterruptedMessage'
  | 'hasCurrentComposerDraft'
  | 'handleRestoreInterruptedMessage'
  | 'handleDiscardInterruptedMessage'
  | 'conversationReferenceRefs'
  | 'onRemoveContextRef'
  | 'chipContextRefs'
  | 'hasAttachments'
  | 'attachments'
  | 'removeAttachment'
  | 'isUploadingAttachments'
  | 'uploadProgress'
  | 'handleCancelUpload'
  | 'isDragOver'
>

export function ChatInputComposerDraftSections({
  compactLeft,
  resolvedPresetScopeId,
  disabled,
  replyTarget,
  sessionId,
  pendingInterruptedMessage,
  hasCurrentComposerDraft,
  handleRestoreInterruptedMessage,
  handleDiscardInterruptedMessage,
  conversationReferenceRefs,
  onRemoveContextRef,
  chipContextRefs,
  hasAttachments,
  attachments,
  removeAttachment,
  isUploadingAttachments,
  uploadProgress,
  handleCancelUpload,
  isDragOver,
}: DraftSectionsProps) {
  const { t } = useTranslation('chat')
  const [viewerRef, setViewerRef] = useState<{ reference: ConversationReferenceDisplay; rawBlock: string } | null>(null)

  return (
    <div className="contents">
      {resolvedPresetScopeId && (
        <ComposerPresetCardList
          sessionId={resolvedPresetScopeId}
          disabled={disabled ?? false}
          hidden={false}
        />
      )}

      {replyTarget && (
        <div className={cn('pt-2', compactLeft ? 'pl-1 pr-2.5' : 'px-2.5')}>
          <ReplyQuoteBar
            preview={replyTarget.preview}
            onClose={() => { if (sessionId) useChatStore.getState().clearReplyTarget(sessionId) }}
          />
        </div>
      )}

      {pendingInterruptedMessage && hasCurrentComposerDraft && (
        <div className={cn('flex items-center justify-between gap-2 pt-2', compactLeft ? 'pl-1 pr-2.5' : 'px-2.5')}>
          <span className={COMPOSER_TEXT_META}>
            {t('input.interruptedMessageSaved')}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={handleRestoreInterruptedMessage}
              className={cn('rounded-md px-1.5 py-0.5 text-primary hover:bg-primary/5', COMPOSER_TEXT_META_BASE)}
              aria-label={t('input.restoreInterruptedMessage')}
            >
              {t('input.restoreInterruptedMessage')}
            </button>
            <button
              type="button"
              onClick={handleDiscardInterruptedMessage}
              className={cn('rounded-md px-1.5 py-0.5 hover:bg-foreground/[0.03] hover:text-foreground', COMPOSER_TEXT_META)}
              aria-label={t('input.discardInterruptedMessage')}
            >
              {t('input.discardInterruptedMessage')}
            </button>
          </div>
        </div>
      )}

      {conversationReferenceRefs.length > 0 && (
        <div className={cn('flex flex-wrap gap-2 pt-2.5 pb-1', compactLeft ? 'pl-1 pr-2.5' : 'px-2.5')}>
          {conversationReferenceRefs.map(ref => {
            const display = conversationReferenceDisplayFromContextRef(ref)
            const rawBlock = typeof ref.meta?.rawBlock === 'string' ? ref.meta.rawBlock : ''
            return (
              <ConversationReferenceCard
                key={ref.id}
                reference={display}
                align="left"
                onOpen={rawBlock ? () => setViewerRef({ reference: display, rawBlock }) : undefined}
                onRemove={onRemoveContextRef ? () => onRemoveContextRef(ref.id) : undefined}
              />
            )
          })}
          {viewerRef && (
            <ConversationReferenceViewerDialog
              open={!!viewerRef}
              onOpenChange={(open) => { if (!open) setViewerRef(null) }}
              reference={viewerRef.reference}
              rawBlock={viewerRef.rawBlock}
            />
          )}
        </div>
      )}

      {chipContextRefs.length > 0 && (
        <ContextChipList refs={chipContextRefs} onRemove={onRemoveContextRef || (() => {})} />
      )}

      {hasAttachments && (
        <div className={cn('flex flex-wrap gap-2 pt-2.5 pb-1', compactLeft ? 'pl-1 pr-2.5' : 'px-2.5')}>
          {attachments.map(att => (
            <AttachmentPreview
              key={att.id}
              attachment={att}
              onRemove={removeAttachment}
            />
          ))}
        </div>
      )}

      {isUploadingAttachments && (
        <div className={cn('flex items-center gap-2 py-1.5', compactLeft ? 'pl-2 pr-2.5' : 'px-2.5')}>
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="h-1 w-full rounded-full bg-muted/30 overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${Math.round((uploadProgress ?? 0) * 100)}%` }}
              />
            </div>
          </div>
          <span className={cn(COMPOSER_TEXT_MICRO, 'text-muted-foreground tabular-nums shrink-0')}>
            {Math.round((uploadProgress ?? 0) * 100)}%
          </span>
          <ChatIconTooltip content={t('input.cancelUpload', { defaultValue: '取消上传' })}>
            <button
              type="button"
              onClick={handleCancelUpload}
              className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/60 hover:bg-destructive/5 hover:text-destructive transition-colors shrink-0"
              aria-label={t('input.cancelUpload', { defaultValue: '取消上传' })}
            >
              <X className="h-3 w-3" />
            </button>
          </ChatIconTooltip>
        </div>
      )}

      {isDragOver && (
        <div className={cn('chat-composer-drag-text flex items-center justify-center gap-2 px-4 py-3 font-medium', COMPOSER_TEXT_META_BASE)}>
          <ImageIcon className="h-4 w-4" />
          <span>{t('input.dropHint')}</span>
        </div>
      )}
    </div>
  )
}
