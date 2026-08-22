/**
 * VirtuosoHoverScroller — react-virtuoso 自定义 Scroller
 *
 * 复用 Electron 全局 `scrollbar-hover` 约定（globals.css / tailwind-preset）：
 * 默认隐藏滚动条，鼠标悬停容器时显示。与 MessageList、ChatSessionSwitcher、
 * SIDEBAR_SCROLLBAR_TYPE 等侧栏/列表面板对齐。
 */

import React from 'react'
import { cn } from '@utils/cn'

export const VirtuosoHoverScroller = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ style, className, ...props }, ref) => (
  <div
    {...props}
    ref={ref}
    className={cn('scrollbar-hover', className)}
    style={{ ...style, overflowX: 'hidden' }}
  />
))
VirtuosoHoverScroller.displayName = 'VirtuosoHoverScroller'
