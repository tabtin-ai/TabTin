/**
 * EmojiReactionBar — 消息 emoji 反应计数条 + 快速选择面板
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { addReaction, removeReaction } from '@/services/tabchatApi'
import { EmojiPanel } from './EmojiPanel'
import { showReactionErrorToast } from './reactionErrorToast'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import {
  EMOJI_QUICK_PICKER_WIDTH,
  type EmojiQuickPickerAlign,
  type EmojiQuickPickerPosition,
  resolveEmojiQuickPickerBounds,
  resolveEmojiQuickPickerPosition,
} from './emojiQuickPickerPosition'

interface EmojiReactionBarProps {
  reactions: Record<string, string[]>
  reactionCounts?: Record<string, number>
  messageRef: string
  messageSequence?: number
  conversationId: string
}

export const EmojiReactionBar: React.FC<EmojiReactionBarProps> = ({
  reactions,
  reactionCounts = {},
  messageRef,
  messageSequence,
  conversationId,
}) => {
  const userId = useAuthStore((s) => s.user?.id) ?? ''
  const entries = Object.entries(reactions)

  const handleToggle = useCallback(
    async (emoji: string) => {
      if (!userId) return
      const users = reactions[emoji] || []
      const isRemoving = users.includes(userId)
      const action = isRemoving ? 'remove' : 'add'

      useIMStore.getState().onReactionUpdated(conversationId, messageRef, emoji, userId, action)

      try {
        if (isRemoving) {
          await removeReaction(conversationId, messageRef, emoji, messageSequence)
        } else {
          await addReaction(conversationId, messageRef, emoji, messageSequence)
        }
      } catch (err) {
        console.error('[TabChat] Failed to toggle reaction:', err)
        const rollbackAction = isRemoving ? 'add' : 'remove'
        useIMStore.getState().onReactionUpdated(conversationId, messageRef, emoji, userId, rollbackAction)
        showReactionErrorToast(err)
      }
    },
    [userId, reactions, conversationId, messageRef, messageSequence],
  )

  if (entries.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {entries.map(([emoji, users]) => {
        const isMine = users.includes(userId)
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => handleToggle(emoji)}
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-body transition-colors border ${
              isMine
                ? 'bg-accent/15 border-accent/40 text-accent'
                : 'bg-muted/30 border-border/30 text-muted-foreground hover:bg-muted/60'
            }`}
          >
            <span>{emoji}</span>
            <span className="min-w-[0.75rem] text-center">
              {reactionCounts[emoji] ?? users.length}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * EmojiQuickPicker — 消息操作条上的快速 emoji 选择面板。
 * 挂到 body(fixed)，相对锚点定位并钳进消息列表视口，避免贴侧栏被裁切。
 */

interface EmojiQuickPickerProps {
  reactions: Record<string, string[]>
  messageRef: string
  messageSequence?: number
  conversationId: string
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
  /** start=左对齐锚点（对方消息）；end=右对齐（自己消息） */
  align?: EmojiQuickPickerAlign
}

export const EmojiQuickPicker: React.FC<EmojiQuickPickerProps> = ({
  reactions,
  messageRef,
  messageSequence,
  conversationId,
  onClose,
  anchorRef,
  align = 'start',
}) => {
  const userId = useAuthStore((s) => s.user?.id) ?? ''
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<EmojiQuickPickerPosition | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor || typeof window === 'undefined') return

    const place = (panelHeight?: number) => {
      const viewportEl = document.querySelector('[data-im-message-list-viewport]')
      const bounds = resolveEmojiQuickPickerBounds(
        viewportEl,
        window.innerWidth,
        window.innerHeight,
      )
      setPosition(resolveEmojiQuickPickerPosition({
        anchorRect: anchor.getBoundingClientRect(),
        bounds,
        align,
        panelHeight,
      }))
    }

    place()
    // 首帧用预估高度；下一帧用实测高度再钳一次，避免贴顶/底选错方向。
    const raf = window.requestAnimationFrame(() => {
      const measured = panelRef.current?.offsetHeight
      if (measured && measured > 0) place(measured)
    })
    return () => window.cancelAnimationFrame(raf)
  }, [align, anchorRef])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 短生命周期浮层；避免再拉 spaceActivity 进气泡静态 import 链
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [anchorRef, onClose])

  const handlePick = useCallback(
    async (emoji: string) => {
      if (!userId) return
      onClose()
      const isRemoving = (reactions[emoji] ?? []).includes(userId)
      const action = isRemoving ? 'remove' : 'add'

      useIMStore.getState().onReactionUpdated(conversationId, messageRef, emoji, userId, action)

      try {
        if (isRemoving) {
          await removeReaction(conversationId, messageRef, emoji, messageSequence)
        } else {
          await addReaction(conversationId, messageRef, emoji, messageSequence)
        }
      } catch (err) {
        console.error('[TabChat] Failed to add reaction:', err)
        const rollbackAction = isRemoving ? 'add' : 'remove'
        useIMStore.getState().onReactionUpdated(
          conversationId,
          messageRef,
          emoji,
          userId,
          rollbackAction,
        )
        showReactionErrorToast(err)
      }
    },
    [userId, reactions, conversationId, messageRef, messageSequence, onClose],
  )

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={panelRef}
      data-im-scroll-lock-exempt
      data-im-emoji-quick-picker
      data-placement={position?.placement}
      className={`fixed z-dropdown rounded-lg ${OVERLAY_SURFACE_CLASS}`}
      style={{
        width: EMOJI_QUICK_PICKER_WIDTH,
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? 'visible' : 'hidden',
      }}
      onMouseLeave={onClose}
    >
      <EmojiPanel onPick={handlePick} />
    </div>,
    document.body,
  )
}
