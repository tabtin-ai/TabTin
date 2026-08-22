import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as t from '../../theme'
import { ScrollArea } from '../../components/ui/ScrollArea'
import { ZIndex } from '@tabtin/app-shell'

/**
 * 对齐 TabData（@tabtin/smartsheet-ui）的弹出面板视觉规范：
 *
 *   弹出层圆角 : rounded-md  = calc(var(--radius) - 2px) ≈ 7.6px  → t.radiusMd
 *   弹出层边框 : border      = 1px solid hsl(var(--border))        → t.border（全透明度）
 *   弹出层阴影 : shadow-md   = 0 4px 6px -1px rgb(0 0 0/0.1), …
 *   弹出层背景 : bg-popover  = hsl(var(--popover)) ≈ #FFFFFF       → t.bgApp
 *   菜单项圆角 : rounded-sm  = calc(var(--radius) - 4px) ≈ 5.6px  → t.radiusSm
 *   菜单项 pad : px-3 py-2   = 12px 8px
 *   菜单项字号 : text-body     = 13px（标签/描述统一）
 *   区块标题   : text-body font-medium = 13px 500
 *   Hover 色   : hover:bg-muted ≈ hsl(var(--muted))
 *   sideOffset : 4px（Radix 默认）
 */

/* ------------------------------------------------------------------ */
/*  CSS animation keyframes (injected once)                           */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'tabslide-panel-animations'

function ensureAnimationStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    @keyframes tabslide-panel-in {
      from { opacity: 0; transform: translateY(-4px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes tabslide-panel-out {
      from { opacity: 1; transform: translateY(0) scale(1); }
      to   { opacity: 0; transform: translateY(-4px) scale(0.97); }
    }
    .tabslide-panel-enter {
      animation: tabslide-panel-in 0.15s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    .tabslide-panel-exit {
      animation: tabslide-panel-out 0.1s ease-in forwards;
      pointer-events: none;
    }

    .tabslide-panel-item:hover {
      background: ${t.bgMuted} !important;
      color: ${t.textPrimary} !important;
    }
    .tabslide-panel-item:active {
      background: ${t.bgActive} !important;
    }

    .tabslide-grid-item:hover {
      background: ${t.bgMuted} !important;
    }
    .tabslide-grid-item:active {
      background: ${t.bgActive} !important;
      transform: scale(0.95);
    }

    .tabslide-panel-input:focus {
      border-color: ${t.accent} !important;
      box-shadow: 0 0 0 2px ${t.accentBg} !important;
    }

    .tabslide-tag-btn:hover {
      border-color: ${t.accent} !important;
      color: ${t.accent} !important;
      background: ${t.accentBg} !important;
    }
  `
  document.head.appendChild(style)
}

/* ------------------------------------------------------------------ */
/*  PanelWrapper – 统一面板容器                                        */
/* ------------------------------------------------------------------ */

export interface PanelWrapperProps {
  width?: React.CSSProperties['width']
  maxHeight?: number
  children: React.ReactNode
  style?: React.CSSProperties
}

export const PanelWrapper: React.FC<PanelWrapperProps> = ({
  width = 240,
  maxHeight,
  children,
  style,
}) => {
  useEffect(() => { ensureAnimationStyles() }, [])

  const resolvedMaxHeight = typeof maxHeight === 'number'
    ? `min(${maxHeight}px, var(--tabslide-dropdown-max-height, ${maxHeight}px))`
    : undefined

  return (
    <ScrollArea
      style={{
        width,
        maxWidth: '100%',
        minWidth: 0,
        maxHeight: resolvedMaxHeight,
      }}
      scrollBar={maxHeight ? 'vertical' : 'none'}
      viewportStyle={style}
    >
      {children}
    </ScrollArea>
  )
}

/* ------------------------------------------------------------------ */
/*  PanelSection – 面板区块（标题 + 内容）                              */
/*  对齐 TabData: border-b px-4 py-2.5 / text-body font-medium       */
/* ------------------------------------------------------------------ */

export interface PanelSectionProps {
  title?: string
  children: React.ReactNode
  noPadding?: boolean
}

export const PanelSection: React.FC<PanelSectionProps> = ({
  title,
  children,
  noPadding,
}) => (
  <div>
    {title && (
      <div style={{
        fontSize: 12,
        fontWeight: 500,
        color: t.textSecondary,
        padding: '8px 16px 6px',
        userSelect: 'none',
        lineHeight: 1,
      }}>
        {title}
      </div>
    )}
    <div style={noPadding ? undefined : { padding: '0 8px 8px' }}>
      {children}
    </div>
  </div>
)

/* ------------------------------------------------------------------ */
/*  PanelMenuItem – 列表菜单项                                         */
/*  对齐 TabData: rounded-sm px-3 py-2 text-body hover:bg-muted      */
/* ------------------------------------------------------------------ */

export interface PanelMenuItemProps {
  icon?: React.ReactNode
  label: string
  description?: string
  onClick: () => void
  iconColor?: string
}

export const PanelMenuItem: React.FC<PanelMenuItemProps> = ({
  icon,
  label,
  description,
  onClick,
  iconColor,
}) => (
  <button
    className="tabslide-panel-item"
    onClick={onClick}
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      width: '100%',
      border: 'none',
      background: 'transparent',
      padding: '8px 12px',
      borderRadius: t.radiusSm,
      cursor: 'pointer',
      textAlign: 'left',
      transition: 'background 0.12s ease',
    }}
  >
    {icon && (
      <span style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: 28,
        height: 28,
        borderRadius: t.radiusSm,
        background: t.bgMuted,
        color: iconColor || t.textSecondary,
      }}>
        {icon}
      </span>
    )}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{
        fontSize: 13,
        fontWeight: 400,
        color: t.textPrimary,
        lineHeight: 1.4,
      }}>
        {label}
      </div>
      {description && (
        <div style={{
          fontSize: 12,
          color: t.textSecondary,
          lineHeight: 1.3,
          marginTop: 1,
        }}>
          {description}
        </div>
      )}
    </div>
  </button>
)

/* ------------------------------------------------------------------ */
/*  PanelGridItem – 网格按钮项                                         */
/*  对齐 TabData: rounded-sm                                        */
/* ------------------------------------------------------------------ */

export interface PanelGridItemProps {
  children: React.ReactNode
  onClick: () => void
  title?: string
  size?: number
}

export const PanelGridItem: React.FC<PanelGridItemProps> = ({
  children,
  onClick,
  title,
  size = 44,
}) => (
  <button
    className="tabslide-grid-item"
    onClick={onClick}
    title={title}
    style={{
      border: 'none',
      background: 'transparent',
      padding: 4,
      borderRadius: t.radiusSm,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: size,
      height: size,
      transition: 'background 0.12s ease, transform 0.1s ease',
    }}
  >
    {children}
  </button>
)

/* ------------------------------------------------------------------ */
/*  PanelDivider – 分割线                                              */
/*  对齐 TabData: border-t (1px solid hsl(var(--border)))           */
/* ------------------------------------------------------------------ */

export const PanelDivider: React.FC = () => (
  <div style={{
    height: 1,
    background: t.border,
    margin: '4px 12px',
  }} />
)

/* ------------------------------------------------------------------ */
/*  PanelFooter – 面板底部                                             */
/*  对齐 TabData: border-t px-4 py-3                                */
/* ------------------------------------------------------------------ */

export const PanelFooter: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    borderTop: `1px solid ${t.border}`,
    padding: '12px 16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  }}>
    {children}
  </div>
)

/* ------------------------------------------------------------------ */
/*  AnimatedDropdown – 带动画的弹出层（供 DropdownToolBtn 使用）         */
/*  对齐 TabData PopoverContent:                                     */
/*    rounded-md, border, bg-popover, shadow-md, sideOffset=4        */
/* ------------------------------------------------------------------ */

export interface AnimatedDropdownProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  align?: 'center' | 'left' | 'right'
  anchorRef: React.RefObject<HTMLElement | null>
}

export const AnimatedDropdown: React.FC<AnimatedDropdownProps> = ({
  open,
  onClose,
  children,
  align = 'center',
  anchorRef,
}) => {
  const [visible, setVisible] = useState(false)
  const [animClass, setAnimClass] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)

  useEffect(() => { ensureAnimationStyles() }, [])

  useEffect(() => {
    if (open) {
      setVisible(true)
      setAnimClass('tabslide-panel-enter')
    } else if (visible) {
      setAnimClass('tabslide-panel-exit')
      const timer = setTimeout(() => {
        setVisible(false)
        setAnimClass('')
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [open])

  useEffect(() => {
    if (!visible) return
    const updatePosition = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      setAnchorRect(anchor.getBoundingClientRect())
    }
    updatePosition()

    const onScrollOrResize = () => updatePosition()
    window.addEventListener('resize', onScrollOrResize)
    window.addEventListener('scroll', onScrollOrResize, true)
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updatePosition)
      : null
    if (ro && anchorRef.current) ro.observe(anchorRef.current)

    return () => {
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('scroll', onScrollOrResize, true)
      ro?.disconnect()
    }
  }, [visible, anchorRef])

  useEffect(() => {
    if (!visible) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      const insidePanel = !!(ref.current && ref.current.contains(target))
      const insideAnchor = !!(anchorRef.current && anchorRef.current.contains(target))
      if (!insidePanel && !insideAnchor) onClose()
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler) }
  }, [visible, onClose, anchorRef])

  if (!visible || !anchorRect) return null

  const VIEWPORT_GAP = 8
  const DROPDOWN_OFFSET = 4
  const MIN_DROPDOWN_HEIGHT = 180
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 900
  const availableBelow = Math.max(0, viewportHeight - anchorRect.bottom - VIEWPORT_GAP)
  const availableAbove = Math.max(0, anchorRect.top - VIEWPORT_GAP)
  const placeAbove = availableBelow < MIN_DROPDOWN_HEIGHT && availableAbove > availableBelow
  const availableHeight = placeAbove ? availableAbove : availableBelow
  const dropdownMaxHeight = Math.max(MIN_DROPDOWN_HEIGHT, Math.floor(availableHeight - DROPDOWN_OFFSET))

  const left = align === 'left'
    ? anchorRect.left
    : align === 'center'
      ? anchorRect.left + anchorRect.width / 2
      : anchorRect.right

  const transformParts: string[] = []
  if (align === 'center') transformParts.push('translateX(-50%)')
  else if (align === 'right') transformParts.push('translateX(-100%)')
  if (placeAbove) transformParts.push('translateY(-100%)')
  const transform = transformParts.length > 0 ? transformParts.join(' ') : undefined

  const dropdownSurfaceStyle: React.CSSProperties = {
    background: t.bgApp,
    border: `1px solid ${t.border}`,
    borderRadius: t.radiusMd,
    boxShadow: t.shadowFloating,
    overflow: 'hidden',
    transformOrigin: 'top center',
  }
  ;(dropdownSurfaceStyle as Record<string, string | number>)['--tabslide-dropdown-max-height'] = `${dropdownMaxHeight}px`

  const content = (
    <div
      style={{
        position: 'fixed',
        top: placeAbove ? anchorRect.top - DROPDOWN_OFFSET : anchorRect.bottom + DROPDOWN_OFFSET,
        left,
        transform,
        zIndex: ZIndex.dropdown,
      }}
    >
      <div
        ref={ref}
        className={animClass}
        style={dropdownSurfaceStyle}
      >
        {children}
      </div>
    </div>
  )

  if (typeof document === 'undefined') return content
  return createPortal(content, document.body)
}
