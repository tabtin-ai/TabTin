/**
 * ContextMenuCheckbox 组件
 * 菜单内复选框
 */

import React from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../utils/cn'
import type { ContextMenuCheckboxProps } from './types'

export const ContextMenuCheckbox: React.FC<ContextMenuCheckboxProps> = ({
  label,
  checked,
  onChange,
  disabled = false,
  className,
  testId,
}) => {
  const handleClick = () => {
    if (disabled) return
    onChange(!checked)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      onChange(!checked)
    }
  }

  return (
    <div
      className={cn('context-menu-checkbox', className)}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={disabled ? -1 : 0}
      role="menuitemcheckbox"
      aria-checked={checked}
      aria-disabled={disabled}
      data-checked={checked}
      data-disabled={disabled}
      data-testid={testId}
    >
      <div className="context-menu-checkbox__box">
        <Check className="context-menu-checkbox__check" />
      </div>
      <span className="context-menu-checkbox__label">{label}</span>
    </div>
  )
}

