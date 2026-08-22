/**
 * Skeleton 组件
 *
 * 统一的骨架屏组件，用于加载占位。
 * 设计：扁平风格，简洁的脉冲动画。
 *
 * @module Skeleton
 * @version 1.0.0
 */

import React from 'react'
import { cn } from '../../utils/cn'

export interface SkeletonProps {
  /** 骨架数量 */
  count?: number
  /** 高度 */
  height?: string
  /** 宽度 */
  width?: string
  /** 圆角 */
  rounded?: 'sm' | 'md' | 'lg' | 'full'
  /** 自定义类名 */
  className?: string
}

/**
 * 骨架屏组件
 *
 * @example
 * ```tsx
 * <Skeleton count={3} height="20px" rounded="md" />
 * ```
 */
export const Skeleton: React.FC<SkeletonProps> = ({
  count = 1,
  height = '16px',
  width = '100%',
  rounded = 'md',
  className
}) => {
  const roundedClass = {
    sm: 'rounded-sm',
    md: 'rounded-md',
    lg: 'rounded-lg',
    full: 'rounded-full'
  }[rounded]

  const items = Array.from({ length: count }, (_, i) => (
    <div
      key={i}
      className={cn(
        'animate-pulse bg-muted',
        roundedClass,
        className
      )}
      style={{ height, width }}
    />
  ))

  return count === 1 ? items[0] : <div className="space-y-2">{items}</div>
}







