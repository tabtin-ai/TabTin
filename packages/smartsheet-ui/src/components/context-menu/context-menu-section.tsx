/**
 * ContextMenuSection 组件
 * 菜单分组
 */

import React from 'react'
import { cn } from '../../utils/cn'
import type { ContextMenuSectionProps } from './types'

export const ContextMenuSection: React.FC<ContextMenuSectionProps> = ({
  label,
  children,
  className,
}) => {
  return (
    <div className={cn('context-menu-section', className)} role="group">
      {label && (
        <div className="context-menu-section__label">
          {label}
        </div>
      )}
      {children}
    </div>
  )
}

