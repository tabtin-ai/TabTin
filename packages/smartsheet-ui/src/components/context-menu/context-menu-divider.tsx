/**
 * ContextMenuDivider 组件
 * 0.5px 细分隔线
 */

import React from 'react'
import { cn } from '../../utils/cn'
import type { ContextMenuDividerProps } from './types'

export const ContextMenuDivider: React.FC<ContextMenuDividerProps> = ({ className }) => {
  return <div className={cn('context-menu-divider', className)} role="separator" />
}

