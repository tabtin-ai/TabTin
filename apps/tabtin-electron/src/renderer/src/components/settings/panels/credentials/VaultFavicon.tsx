/**
 * VaultFavicon —— favicon fallback（macOS Passwords 克制风格）。
 *
 * 设计取向：
 *  - 不联网请求 favicon（避免把用户访问偏好暴露给第三方 CDN）
 *  - 不用彩虹色调色板——和 macOS Passwords 一致用单一中性灰底 + 字母
 *  - 视觉退到背景，让条目本身的标题/副标题成为主视觉
 */

import React from 'react'
import { cn } from '@utils/cn'
import { SETTINGS_TEXT_MICRO } from '../../settingsUi'

interface VaultFaviconProps {
  host: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export const VaultFavicon: React.FC<VaultFaviconProps> = ({ host, size = 'md', className }) => {
  const stripped = host.replace(/^\./, '').replace(/^www\./, '')
  const letter = (stripped[0] || '?').toUpperCase()
  const sizeClass =
    size === 'sm' ? cn('h-6 w-6', SETTINGS_TEXT_MICRO) : size === 'lg' ? 'h-14 w-14 text-title' : 'h-8 w-8 text-body'

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium shrink-0',
        'bg-muted/60 text-foreground/80',
        sizeClass,
        className,
      )}
      aria-hidden="true"
    >
      {letter}
    </span>
  )
}
