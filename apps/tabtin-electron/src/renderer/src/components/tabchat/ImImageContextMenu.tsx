/**
 * IM 右键菜单：单项「复制」（图片 / 文字共用壳）。
 */

import React, { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy } from 'lucide-react'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'

export interface ImImageContextMenuProps {
  x: number
  y: number
  onCopy: () => void
  onClose: () => void
  /** 默认「复制图片」；文字消息传「复制」等 */
  copyLabel?: string
  menuAriaLabel?: string
}

export const ImImageContextMenu: React.FC<ImImageContextMenuProps> = ({
  x,
  y,
  onCopy,
  onClose,
  copyLabel,
  menuAriaLabel,
}) => {
  const { t } = useTranslation('tabchat')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDocPointer = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-im-image-context-menu="true"]')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDocPointer, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDocPointer, true)
    }
  }, [onClose])

  const menuStyle = useMemo<React.CSSProperties>(() => {
    const MENU_WIDTH = 160
    const MENU_HEIGHT = 40
    const margin = 8
    return {
      left: Math.max(margin, Math.min(x, window.innerWidth - MENU_WIDTH - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - MENU_HEIGHT - margin)),
    }
  }, [x, y])

  return (
    <div
      data-im-image-context-menu="true"
      role="menu"
      aria-label={menuAriaLabel ?? t('imageMenu', { defaultValue: '图片菜单' })}
      className={cn('fixed z-dropdown min-w-[140px] rounded-interactive py-1 text-caption', OVERLAY_SURFACE_CLASS)}
      style={menuStyle}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCopy()
          onClose()
        }}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-foreground hover:bg-muted/40"
      >
        <Copy className="h-3.5 w-3.5" aria-hidden />
        {copyLabel ?? t('copyImage', { defaultValue: '复制图片' })}
      </button>
    </div>
  )
}
