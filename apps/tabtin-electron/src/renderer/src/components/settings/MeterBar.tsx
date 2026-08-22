import React from 'react'
import { cn } from '@utils/cn'
import { chartSeriesBarColor } from './panels/dashboardChartTokens'

/**
 * MeterBar —— 仪表盘/设置面板里的条形进度条统一出口（参考 shadcn charts）。
 *
 * 统一了 Storage / Usage / 配额 等处各自手写的「轨道 + 填充」条形：
 *  - variant='series'：分类/分布数据，按 colorIndex 循环取 shadcn chart 调色板（bg-chart-1..5）。
 *  - variant='threshold'：用量/配额「健康度」，按百分比 info → warning(≥80) → destructive(≥95)。
 *  - color：显式覆盖填充色（如日趋势的实时态用 bg-warning），优先级最高。
 *
 * 两种布局：
 *  - 裸条（默认，不传 label）：仅 track+fill，嵌进调用方自定义的行里。
 *  - 行布局（传 label）：icon + label + 条 + valueLabel，覆盖 Storage BarRow 这类分布列表。
 */
export type MeterBarVariant = 'series' | 'threshold'

function resolveColor(variant: MeterBarVariant, pct: number, colorIndex: number, color?: string): string {
  if (color) return color
  if (variant === 'threshold') {
    return pct >= 95 ? 'bg-destructive' : pct >= 80 ? 'bg-warning' : 'bg-info'
  }
  return chartSeriesBarColor(colorIndex)
}

export interface MeterBarProps {
  value: number
  max: number
  variant?: MeterBarVariant
  colorIndex?: number
  /** 显式填充色（bg-* 类），优先于 variant。 */
  color?: string
  /** 传入则启用「icon + label + 条 + value」行布局；否则只渲染裸条。 */
  label?: React.ReactNode
  icon?: React.ReactNode
  valueLabel?: React.ReactNode
  labelClassName?: string
  valueClassName?: string
  /** 裸条模式作用于 track；行布局模式作用于外层行。 */
  className?: string
  trackClassName?: string
}

export const MeterBar: React.FC<MeterBarProps> = ({
  value,
  max,
  variant = 'series',
  colorIndex = 0,
  color,
  label,
  icon,
  valueLabel,
  labelClassName,
  valueClassName,
  className,
  trackClassName,
}) => {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  const fillColor = resolveColor(variant, pct, colorIndex, color)
  const fill = <div className={cn('h-full rounded-full transition-colors', fillColor)} style={{ width: `${pct}%` }} />

  if (label === undefined) {
    return (
      <div className={cn('h-2 rounded-full bg-muted/30 overflow-hidden', className)}>{fill}</div>
    )
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {icon && <span className="w-5 text-center text-body shrink-0">{icon}</span>}
      <span className={cn('text-body text-foreground-secondary shrink-0 truncate', labelClassName ?? 'w-20')}>{label}</span>
      <div className={cn('flex-1 h-2 rounded-full bg-muted/30 overflow-hidden', trackClassName)}>{fill}</div>
      {valueLabel !== undefined && (
        <span className={cn('text-body tabular-nums text-muted-foreground/60 text-right shrink-0', valueClassName ?? 'w-20')}>
          {valueLabel}
        </span>
      )}
    </div>
  )
}

MeterBar.displayName = 'MeterBar'
