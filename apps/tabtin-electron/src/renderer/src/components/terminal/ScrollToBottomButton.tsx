/**
 * ScrollToBottomButton - 终端滚动到底部的浮动按钮
 *
 * 当用户向上滚动查看历史输出时显示，点击后跳回最新输出。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { ArrowDown } from 'lucide-react'
import {
  onTerminalScrollChange,
  scrollTerminalToBottom,
  isTerminalAtBottom,
} from './terminalRuntime'

interface ScrollToBottomButtonProps {
  sessionId: string
}

export const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({
  sessionId,
}) => {
  const { t } = useTranslation('terminal')
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    // 初始状态
    setAtBottom(isTerminalAtBottom(sessionId))
    // 订阅滚动状态变化
    return onTerminalScrollChange(sessionId, setAtBottom)
  }, [sessionId])

  const handleClick = useCallback(() => {
    scrollTerminalToBottom(sessionId)
  }, [sessionId])

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={t('scrollToBottom')}
      className={cn(
        'absolute bottom-3 right-3 z-sticky',
        'h-7 w-7 rounded-full',
        'bg-muted/80 hover:bg-muted border border-border',
        'flex items-center justify-center',
        'transition-all duration-200',
        'shadow-sm hover:shadow',
        atBottom
          ? 'opacity-0 pointer-events-none translate-y-2'
          : 'opacity-100 translate-y-0',
      )}
    >
      <ArrowDown className="h-3.5 w-3.5 text-muted-foreground" />
    </button>
  )
}
