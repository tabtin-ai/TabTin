/**
 * IMMessageActionBar — 消息悬浮操作条
 *
 * 悬停时贴气泡外侧，样式对齐侧栏任务行操作钮：毛玻璃底、无描边。
 */

import React, { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  Loader2,
  MoreHorizontal,
  Pin,
  PinOff,
  Pencil,
  Reply,
  Share2,
  Smile,
  Undo2,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@components/ui'
import { ChatIconTooltip } from '@components/chat/panel/ChatIconTooltip'
import { SHELL_MENU_LUCIDE_ICON_CLASS, SHELL_MENU_LUCIDE_ICON_STROKE } from '@components/layout/sidebarUi'
import { cn } from '@utils/cn'
import { EmojiQuickPicker } from './EmojiReactionBar'
import {
  IM_MESSAGE_ACTION_BAR_CLASS,
  IM_MESSAGE_ACTION_BUTTON_CLASS,
  IM_MESSAGE_ACTION_ICON_CLASS,
} from './tabchatUi'

const IM_MENU_ICON = SHELL_MENU_LUCIDE_ICON_CLASS
const IM_MENU_ICON_STROKE = SHELL_MENU_LUCIDE_ICON_STROKE
const IM_MESSAGE_ACTION_TOOLTIP_DELAY_MS = 300

const QUICK_THUMBS_UP = '👍'

interface Props {
  visible: boolean
  isMine: boolean
  messageRef: string
  messageSequence?: number
  conversationId: string
  reactions: Record<string, string[]>
  isPinned: boolean
  canReply: boolean
  canForward: boolean
  canPin: boolean
  canEdit: boolean
  canRecall: boolean
  canCreateAgentTask: boolean
  pinning: boolean
  recalling: boolean
  creatingAgentTask: boolean
  emojiPickerOpen: boolean
  onEmojiPickerOpenChange: (open: boolean) => void
  /** 「更多」菜单打开时由外层保活操作条，避免 portal 菜单抢走悬停后整条消失 */
  moreMenuOpen: boolean
  onMoreMenuOpenChange: (open: boolean) => void
  onQuickReaction: (emoji: string) => void
  onReply?: () => void
  onForward: () => void
  onEdit?: () => void
  onTogglePin: () => void
  onRecall: () => void
  onCreateAgentTask: () => void
}

function ActionButton({
  label,
  onClick,
  disabled,
  children,
  className,
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <ChatIconTooltip content={label} delayDuration={IM_MESSAGE_ACTION_TOOLTIP_DELAY_MS}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(IM_MESSAGE_ACTION_BUTTON_CLASS, className)}
      >
        {children}
      </button>
    </ChatIconTooltip>
  )
}

export const IMMessageActionBar: React.FC<Props> = ({
  visible,
  isMine,
  messageRef,
  messageSequence,
  conversationId,
  reactions,
  isPinned,
  canReply,
  canForward,
  canPin,
  canEdit,
  canRecall,
  canCreateAgentTask,
  pinning,
  recalling,
  creatingAgentTask,
  emojiPickerOpen,
  onEmojiPickerOpenChange,
  moreMenuOpen,
  onMoreMenuOpenChange,
  onQuickReaction,
  onReply,
  onForward,
  onEdit,
  onTogglePin,
  onRecall,
  onCreateAgentTask,
}) => {
  const { t } = useTranslation('tabchat')
  const emojiAnchorRef = useRef<HTMLDivElement>(null)

  const hasMoreActions = canPin || canEdit || canRecall

  return (
    <div
      data-im-message-action-bar
      // 悬停条是浮动层，不是下拉。z-dropdown(55) 高于 z-modal(50)，会盖住续接向导。
      className={cn(
        IM_MESSAGE_ACTION_BAR_CLASS,
        isMine ? 'right-full mr-2' : 'left-full ml-2',
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none',
      )}
    >
        <ActionButton
          label={t('quickReactionLike', { defaultValue: '赞' })}
          onClick={() => onQuickReaction(QUICK_THUMBS_UP)}
        >
          <span className="text-caption leading-none select-none">{QUICK_THUMBS_UP}</span>
        </ActionButton>

        <div ref={emojiAnchorRef} className="relative">
          <ActionButton
            label={t('addReaction')}
            onClick={() => onEmojiPickerOpenChange(!emojiPickerOpen)}
            className={emojiPickerOpen ? 'bg-foreground/[0.05] text-foreground' : undefined}
          >
            <Smile className={IM_MESSAGE_ACTION_ICON_CLASS} />
          </ActionButton>
          {emojiPickerOpen && (
            <EmojiQuickPicker
              reactions={reactions}
              messageRef={messageRef}
              messageSequence={messageSequence}
              conversationId={conversationId}
              anchorRef={emojiAnchorRef}
              align={isMine ? 'end' : 'start'}
              onClose={() => onEmojiPickerOpenChange(false)}
            />
          )}
        </div>

        {canReply && onReply && (
          <ActionButton label={t('reply')} onClick={onReply}>
            <Reply className={IM_MESSAGE_ACTION_ICON_CLASS} />
          </ActionButton>
        )}

        {canForward && (
          <ActionButton label={t('forward')} onClick={onForward}>
            <Share2 className={IM_MESSAGE_ACTION_ICON_CLASS} />
          </ActionButton>
        )}

        {canCreateAgentTask && (
          <ActionButton
            label={t('createAgentTaskFromMessage', { defaultValue: '询问 Agent' })}
            onClick={onCreateAgentTask}
            disabled={creatingAgentTask}
          >
            {creatingAgentTask ? (
              <Loader2 className={cn(IM_MESSAGE_ACTION_ICON_CLASS, 'animate-spin')} />
            ) : (
              <Bot className={IM_MESSAGE_ACTION_ICON_CLASS} />
            )}
          </ActionButton>
        )}

        {hasMoreActions && (
          <DropdownMenu
            modal={false}
            open={moreMenuOpen}
            onOpenChange={onMoreMenuOpenChange}
          >
            <ChatIconTooltip
              content={t('messageActionsMore', { defaultValue: '更多' })}
              delayDuration={IM_MESSAGE_ACTION_TOOLTIP_DELAY_MS}
            >
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('messageActionsMore', { defaultValue: '更多' })}
                    className={cn(
                      IM_MESSAGE_ACTION_BUTTON_CLASS,
                      moreMenuOpen && 'bg-foreground/[0.05] text-foreground',
                    )}
                  >
                    <MoreHorizontal className={IM_MESSAGE_ACTION_ICON_CLASS} />
                  </button>
                </DropdownMenuTrigger>
            </ChatIconTooltip>
            <DropdownMenuContent
              align={isMine ? 'end' : 'start'}
              className="min-w-[168px]"
              data-im-scroll-lock-exempt
            >
              {canPin && (
                <DropdownMenuItem
                  disabled={pinning}
                  onSelect={onTogglePin}
                  className="gap-2"
                >
                  {isPinned ? <PinOff className={IM_MENU_ICON} strokeWidth={IM_MENU_ICON_STROKE} /> : <Pin className={IM_MENU_ICON} strokeWidth={IM_MENU_ICON_STROKE} />}
                  <span>{t(isPinned ? 'unpin' : 'pinMessage')}</span>
                </DropdownMenuItem>
              )}
              {canEdit && onEdit && (
                <DropdownMenuItem onSelect={onEdit} className="gap-2">
                  <Pencil className={IM_MENU_ICON} strokeWidth={IM_MENU_ICON_STROKE} />
                  <span>{t('editMessage')}</span>
                </DropdownMenuItem>
              )}
              {canRecall && (canPin || canEdit) && <DropdownMenuSeparator />}
              {canRecall && (
                <DropdownMenuItem
                  disabled={recalling}
                  onSelect={onRecall}
                  className="gap-2 text-destructive focus:text-destructive"
                >
                  <Undo2 className={IM_MENU_ICON} strokeWidth={IM_MENU_ICON_STROKE} />
                  <span>{t('recallMessage')}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
    </div>
  )
}
