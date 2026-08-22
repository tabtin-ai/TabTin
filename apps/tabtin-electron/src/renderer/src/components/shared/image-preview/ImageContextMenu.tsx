import React, { useMemo } from 'react'
import { Copy } from 'lucide-react'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { useScopedEventListener } from '@hooks/spaceActivity'

export const ImageContextMenu: React.FC<{
  x: number
  y: number
  label: string
  menuLabel: string
  onCopy: () => void
  onClose: () => void
}> = ({ x, y, label, menuLabel, onCopy, onClose }) => {
  const documentTarget = typeof document === 'undefined' ? null : document
  useScopedEventListener<KeyboardEvent>(documentTarget, 'keydown', (event) => {
    if (event.key === 'Escape') onClose()
  })
  useScopedEventListener<MouseEvent>(documentTarget, 'mousedown', (event) => {
    if ((event.target as HTMLElement | null)?.closest('[data-image-context-menu]')) return
    onClose()
  }, { capture: true })

  const style = useMemo<React.CSSProperties>(() => ({
    left: Math.max(8, Math.min(x, window.innerWidth - 168)),
    top: Math.max(8, Math.min(y, window.innerHeight - 48)),
  }), [x, y])

  return (
    <div
      data-image-context-menu
      role="menu"
      aria-label={menuLabel}
      className={cn('fixed z-dropdown min-w-[140px] rounded-interactive py-1 text-caption', OVERLAY_SURFACE_CLASS)}
      style={style}
    >
      <button
        type="button"
        role="menuitem"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-foreground hover:bg-muted/40"
        onClick={() => { onCopy(); onClose() }}
      >
        <Copy className="h-3.5 w-3.5" aria-hidden />
        {label}
      </button>
    </div>
  )
}
