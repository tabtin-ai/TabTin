/**
 * ContextMenuCustom 组件
 * 自定义渲染区域（用于复杂内容）
 */

import React from 'react'
import { cn } from '../../utils/cn'
import type { ContextMenuCustomProps } from './types'

export const ContextMenuCustom: React.FC<ContextMenuCustomProps> = ({
  children,
  className,
}) => {
  return (
    <div className={cn('context-menu-custom', className)}>
      {children}
    </div>
  )
}

