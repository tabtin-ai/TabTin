/**
 * EmojiPanel — 输入与 reaction 共用的 emoji 选择面板。
 *
 * compact 用于消息悬浮 reaction；full 用于输入框，提供「最近使用 + 默认表情」。
 * TabTin 小机器人贴纸入口暂时关闭，底层贴纸消息的渲染与兼容逻辑保持不变。
 */

import React, { useCallback, useMemo, useState } from 'react'
import { Clock3, Smile } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TabtinRobotSticker } from './stickers/tabtinRobotPack'

/** 快捷 reaction 与完整面板的默认高频项。 */
export const COMMON_EMOJIS: string[] = [
  '👍', '❤️', '😂', '🎉', '🔥', '👀', '🙏', '👏',
  '💯', '✅', '🤔', '😅', '😊', '😍', '😎', '🥳',
  '😭', '😮', '😢', '😡', '🤯', '🙌', '👌', '🤝',
  '💪', '✨', '⭐', '💡', '🚀', '🎯', '👋', '🤣',
]

const DEFAULT_EMOJIS: string[] = [
  '👍', '👎', '🙏', '👏', '🙌', '👌', '🤝', '💪', '👋',
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊',
  '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😋',
  '😎', '🤓', '🧐', '🤔', '🤨', '😐', '😑', '🙄', '😏',
  '😣', '😥', '😮', '🤐', '😯', '😪', '😫', '🥱', '😴',
  '😛', '😜', '🤪', '😝', '🤤', '😒', '😓', '😔', '😕',
  '🙁', '😖', '😞', '😟', '😤', '😭', '😢', '😡', '🤯',
  '🥳', '🤩', '🥺', '🤗', '🤭', '🫡', '🫶', '🤌', '🤞',
  '🌹', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍',
  '💯', '✅', '❌', '✨', '⭐', '🔥', '🎉', '🎊', '🎯',
]

const RECENT_STORAGE_KEY = 'tabtin.im.recent-emojis'
const RECENT_LIMIT = 9

type FullTab = 'recent' | 'default'

function readRecentEmojis(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) ?? '[]')
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').slice(0, RECENT_LIMIT)
  } catch {
    // localStorage 不可用或历史值损坏时直接使用默认高频项。
  }
  return []
}

interface Props {
  onPick: (emoji: string) => void
  /**
   * 为贴纸发送链路保留的兼容参数；当前 TabTin 贴纸入口已关闭，面板不会消费。
   */
  onPickSticker?: (sticker: TabtinRobotSticker) => void
  className?: string
  variant?: 'compact' | 'full'
  /** 为贴纸发送链路保留的兼容参数；当前面板不会消费。 */
  stickerSending?: boolean
}

export const EmojiPanel: React.FC<Props> = ({
  onPick,
  className,
  variant = 'compact',
}) => {
  const { t } = useTranslation('tabchat')
  const [recent, setRecent] = useState(readRecentEmojis)
  const [activeTab, setActiveTab] = useState<FullTab>('default')
  const recentItems = useMemo(
    () => [...recent, ...COMMON_EMOJIS].filter((emoji, index, items) => items.indexOf(emoji) === index).slice(0, RECENT_LIMIT),
    [recent],
  )

  const handlePick = useCallback((emoji: string) => {
    const next = [emoji, ...recent.filter((item) => item !== emoji)].slice(0, RECENT_LIMIT)
    setRecent(next)
    try {
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // 隐私模式下存储失败不影响本次插入。
    }
    onPick(emoji)
  }, [onPick, recent])

  const renderEmoji = (emoji: string) => (
    <button
      key={emoji}
      type="button"
      onClick={() => handlePick(emoji)}
      className={`${variant === 'full' ? 'h-10 w-10 text-title' : 'h-7 w-7 text-subtitle'} flex items-center justify-center rounded-lg leading-none hover:bg-muted/60 transition-colors`}
      aria-label={emoji}
    >
      {emoji}
    </button>
  )

  if (variant === 'compact') {
    return (
      <div className={`grid grid-cols-8 gap-0.5 p-1.5 ${className ?? ''}`}>
        {COMMON_EMOJIS.map(renderEmoji)}
      </div>
    )
  }

  const tabButtonClass = (tab: FullTab) =>
    `flex h-9 w-12 items-center justify-center rounded-lg transition-colors ${
      activeTab === tab
        ? 'bg-background text-accent shadow-sm'
        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
    }`

  return (
    <div className={`flex max-h-[520px] min-h-0 flex-col overflow-hidden ${className ?? ''}`}>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-4">
        {activeTab === 'recent' ? (
          <section id="emoji-recent">
            <h3 className="mb-2 text-body font-medium text-muted-foreground">
              {t('emojiMostUsed', { defaultValue: '最近使用' })}
            </h3>
            <div className="grid grid-cols-9 place-items-center gap-x-1 gap-y-0.5">
              {recentItems.map(renderEmoji)}
            </div>
          </section>
        ) : (
          <>
            <section id="emoji-recent">
              <h3 className="mb-2 text-body font-medium text-muted-foreground">
                {t('emojiMostUsed', { defaultValue: '最近使用' })}
              </h3>
              <div className="grid grid-cols-9 place-items-center gap-x-1 gap-y-0.5">
                {recentItems.map(renderEmoji)}
              </div>
            </section>
            <section id="emoji-default" className="mt-4">
              <h3 className="mb-2 text-body font-medium text-muted-foreground">
                {t('emojiDefault', { defaultValue: '默认表情' })}
              </h3>
              <div className="grid grid-cols-9 place-items-center gap-x-1 gap-y-0.5">
                {DEFAULT_EMOJIS.map(renderEmoji)}
              </div>
            </section>
          </>
        )}
      </div>

      <div className="flex h-12 flex-shrink-0 items-center border-t border-border/40 bg-muted/20 px-2">
        <button
          type="button"
          className={tabButtonClass('recent')}
          title={t('emojiMostUsed', { defaultValue: '最近使用' })}
          aria-label={t('emojiMostUsed', { defaultValue: '最近使用' })}
          aria-pressed={activeTab === 'recent'}
          onClick={() => setActiveTab('recent')}
        >
          <Clock3 className="h-5 w-5" />
        </button>
        <button
          type="button"
          className={tabButtonClass('default')}
          title={t('emojiDefault', { defaultValue: '默认表情' })}
          aria-label={t('emojiDefault', { defaultValue: '默认表情' })}
          aria-pressed={activeTab === 'default'}
          onClick={() => setActiveTab('default')}
        >
          <Smile className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
