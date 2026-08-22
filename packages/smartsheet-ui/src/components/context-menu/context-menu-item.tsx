/**
 * ContextMenuItem 组件
 * 菜单项
 */

import React from 'react'
import { Check } from 'lucide-react'

import { cn } from '../../utils/cn'
import type { ContextMenuItemProps } from './types'
import { useContextMenuClose } from './context-menu'

export const ContextMenuItem: React.FC<ContextMenuItemProps> = ({
  icon,
  label,
  suffix,
  shortcut,
  selected = false,
  disabled = false,
  danger = false,
  onClick,
  className,
  closeOnClick = true,
  testId,
}) => {
  const menuClose = useContextMenuClose()

  const handleClick = (e: React.MouseEvent) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()
    onClick?.()
    if (closeOnClick && menuClose) menuClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      onClick?.()
      if (closeOnClick && menuClose) menuClose()
    }
  }

  return (
    <div
      className={cn('context-menu-item', className)}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={disabled ? -1 : 0}
      role="menuitem"
      aria-disabled={disabled}
      data-disabled={disabled}
      data-danger={danger}
      data-selected={selected}
      data-testid={testId}
    >
      {icon && <span className="context-menu-item__icon">{icon}</span>}
      <span className="context-menu-item__label">{label}</span>
      {selected && <Check className="context-menu-item__check" />}
      {suffix && <span className="context-menu-item__suffix">{suffix}</span>}
      {shortcut && <span className="context-menu-item__shortcut">{shortcut}</span>}
    </div>
  )
}

