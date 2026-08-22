/**
 * StatCard 组件
 *
 * 统一的统计卡片组件，用于显示数据指标。
 * 设计：扁平风格，无阴影，使用品牌色图标。
 */

import React from 'react'
import { TrendingUp, TrendingDown, Minus, type LucideIcon } from 'lucide-react'
import { cn } from '../../utils/cn'
import {
  BrandColors,
  SystemColors,
  BorderRadius,
  BorderWidth,
  BorderColors,
  InlineSpacing,
  Transitions,
  FontSize,
  FontWeight,
} from '../../constants/design-tokens'

export type StatCardTrend = 'up' | 'down' | 'neutral'

export interface StatCardProps {
  /** 图标组件 */
  icon: LucideIcon
  /** 图标背景色（默认：bg-brand-50） */
  iconBg?: string
  /** 图标颜色（默认：text-brand-600） */
  iconColor?: string
  /** 标签文字 */
  label: string
  /** 数值 */
  value: string | number
  /** 副标签（显示在数值下方） */
  sublabel?: string
  /** 趋势指示（可选） */
  trend?: StatCardTrend
  /** 趋势值（例如："+12%"） */
  trendValue?: string
  /** 是否可交互（hover效果） */
  interactive?: boolean
  /** 点击回调 */
  onClick?: () => void
  /** 自定义类名 */
  className?: string
}

/**
 * 获取趋势图标和颜色
 */
const getTrendConfig = (trend: StatCardTrend) => {
  const configs = {
    up: {
      icon: TrendingUp,
      color: 'text-success',
    },
    down: {
      icon: TrendingDown,
      color: 'text-destructive',
    },
    neutral: {
      icon: Minus,
      color: 'text-muted-foreground',
    },
  }
  return configs[trend]
}

export const StatCard: React.FC<StatCardProps> = ({
  icon: Icon,
  iconBg = BrandColors[50],
  iconColor = 'text-brand-600',
  label,
  value,
  sublabel,
  trend,
  trendValue,
  interactive = false,
  onClick,
  className,
}) => {
  const trendConfig = trend ? getTrendConfig(trend) : null
  const TrendIcon = trendConfig?.icon

  return (
    <div
      className={cn(
        // 基础样式
        SystemColors.background,
        BorderWidth.thin,
        BorderColors.default,
        BorderRadius.md,
        'p-4',
        // 交互样式
        interactive && [
          Transitions.colors,
          'cursor-pointer',
          `hover:${BorderColors.brandLight}`,
        ],
        // 自定义类名
        className
      )}
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
    >
      <div className={cn('flex items-center', InlineSpacing.md)}>
        {/* 图标容器 */}
        <div
          className={cn(
            'w-11 h-11',
            BorderRadius.md,
            'flex items-center justify-center flex-shrink-0',
            iconBg,
            iconColor
          )}
        >
          <Icon className="w-5 h-5" />
        </div>

        {/* 内容区域 */}
        <div className="flex-1 min-w-0">
          {/* 标签 */}
          <div className={cn(FontSize.caption, 'text-muted-foreground mb-0.5')}>
            {label}
          </div>

          {/* 数值和趋势 */}
          <div className="flex items-baseline gap-2">
            <div
              className={cn(
                FontSize.title,
                FontWeight.bold,
                SystemColors.foreground,
                'truncate'
              )}
            >
              {value}
            </div>

            {/* 趋势指示 */}
            {trendConfig && TrendIcon && (
              <div className={cn('flex items-center gap-1', FontSize.caption, trendConfig.color)}>
                <TrendIcon className="w-3 h-3" />
                {trendValue && <span>{trendValue}</span>}
              </div>
            )}
          </div>

          {/* 副标签 */}
          {sublabel && (
            <div className={cn(FontSize.caption, 'text-muted-foreground mt-0.5')}>
              {sublabel}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
