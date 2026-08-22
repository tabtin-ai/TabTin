import React from 'react'
import { cn } from '@utils/cn'
import {
  SIDEBAR_COUNT,
  SIDEBAR_META_END,
  SIDEBAR_ROW,
  SIDEBAR_ROW_ACTIVE,
  SIDEBAR_ROW_ACTIVE_CONTEXT,
  SIDEBAR_ROW_FULL_WIDTH,
  SIDEBAR_ROW_INACTIVE,
  SIDEBAR_ROW_LABEL_ACTIVE,
  SIDEBAR_ROW_LABEL_GROW,
  SIDEBAR_ROW_RESERVE_ACTIONS,
} from './sidebarUi'

type SidebarMenuItemAs = 'button' | 'div'

export interface SidebarMenuItemProps {
  as?: SidebarMenuItemAs
  active?: boolean
  contextActive?: boolean
  fullWidth?: boolean
  reserveActions?: boolean
  indent?: number
  leading?: React.ReactNode
  label?: React.ReactNode
  trailing?: React.ReactNode
  children?: React.ReactNode
  count?: React.ReactNode
  meta?: React.ReactNode
  className?: string
  activeClassName?: string
  /** 覆盖默认 SIDEBAR_ROW_ACTIVE_CONTEXT（如工作空间浅主题色底） */
  contextActiveClassName?: string
  labelClassName?: string
  countClassName?: string
  metaClassName?: string
  style?: React.CSSProperties
  title?: string
  draggable?: boolean
  disabled?: boolean
  role?: string
  tabIndex?: number
  'aria-label'?: string
  'aria-busy'?: React.AriaAttributes['aria-busy']
  'aria-current'?: React.AriaAttributes['aria-current']
  'aria-disabled'?: React.AriaAttributes['aria-disabled']
  'aria-expanded'?: React.AriaAttributes['aria-expanded']
  'data-testid'?: string
  'data-onboarding-target'?: string
  onClick?: React.MouseEventHandler<HTMLElement>
  onDoubleClick?: React.MouseEventHandler<HTMLElement>
  onMouseDown?: React.MouseEventHandler<HTMLElement>
  onMouseEnter?: React.MouseEventHandler<HTMLElement>
  onFocus?: React.FocusEventHandler<HTMLElement>
  onContextMenu?: React.MouseEventHandler<HTMLElement>
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>
  onDragStart?: React.DragEventHandler<HTMLElement>
  onDragEnd?: React.DragEventHandler<HTMLElement>
  onDragOver?: React.DragEventHandler<HTMLElement>
  onDragLeave?: React.DragEventHandler<HTMLElement>
  onDrop?: React.DragEventHandler<HTMLElement>
}

export const SidebarMenuItem = React.forwardRef<HTMLElement, SidebarMenuItemProps>(({
  as = 'button',
  active = false,
  contextActive = false,
  fullWidth = false,
  reserveActions = false,
  indent,
  leading,
  label,
  trailing,
  children,
  count,
  meta,
  className,
  activeClassName,
  contextActiveClassName,
  labelClassName,
  countClassName,
  metaClassName,
  style,
  ...props
}, ref) => {
  const Component = as
  const mergedStyle = indent === undefined
    ? style
    : { ...style, paddingLeft: `calc(0.75rem + ${indent}px)` }

  return (
    <Component
      ref={ref as never}
      {...(as === 'button' ? { type: 'button' } : {})}
      className={cn(
        SIDEBAR_ROW,
        fullWidth && SIDEBAR_ROW_FULL_WIDTH,
        reserveActions && SIDEBAR_ROW_RESERVE_ACTIONS,
        active
          ? (activeClassName ?? SIDEBAR_ROW_ACTIVE)
          : contextActive
            ? (contextActiveClassName ?? SIDEBAR_ROW_ACTIVE_CONTEXT)
            : SIDEBAR_ROW_INACTIVE,
        className,
      )}
      style={mergedStyle}
      {...props}
    >
      {children ?? (
        <>
          {leading}
          {label !== undefined && (
            <span className={cn(SIDEBAR_ROW_LABEL_GROW, active && SIDEBAR_ROW_LABEL_ACTIVE, labelClassName)}>
              {label}
            </span>
          )}
          {meta !== undefined && <span className={cn(SIDEBAR_META_END, metaClassName)}>{meta}</span>}
          {count !== undefined && <span className={cn(SIDEBAR_COUNT, countClassName)}>{count}</span>}
          {trailing}
        </>
      )}
    </Component>
  )
})

SidebarMenuItem.displayName = 'SidebarMenuItem'
