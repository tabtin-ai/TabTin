import React from 'react'
import { ArrowDown } from 'lucide-react'
import { ChatIconTooltip } from '../../panel/ChatIconTooltip'

export interface MessageListReturnToLatestButtonProps {
  bottomPadding?: number
  label: string
  onClick: () => void
}

export function MessageListReturnToLatestButton({
  bottomPadding,
  label,
  onClick,
}: MessageListReturnToLatestButtonProps) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-sticky flex justify-center"
      // 浮动输入框会盖住消息列表底部——把「回到底部」按钮抬到浮层之上（bottomPadding
      // 即浮层高度+留白）。无浮层时回退到默认 16px。
      style={{ bottom: (bottomPadding ?? 16) + 8 }}
    >
      <ChatIconTooltip content={label}>
        <button
          type="button"
          data-testid="chat-scroll-to-bottom"
          onClick={onClick}
          className="pointer-events-auto flex h-9 min-w-9 items-center justify-center rounded-full bg-background/95 px-3 shadow-lg backdrop-blur-sm transition-all hover:bg-muted/90"
          aria-label={label}
        >
          <ArrowDown className="h-4 w-4 text-muted-foreground" />
        </button>
      </ChatIconTooltip>
    </div>
  )
}
