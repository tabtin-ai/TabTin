/**
 * EmptyState — 通用空状态组件
 *
 * 从 history-timeline EmptyHistoryIllustration 提炼。
 * 所有列表、面板、页面的空状态统一使用此组件。
 *
 * @example
 * // 基础用法
 * <EmptyState title="暂无数据" />
 *
 * // 带图标和描述
 * <EmptyState
 *   icon="clock"
 *   title="暂无变更记录"
 *   description="编辑后，变更历史将在此显示"
 * />
 *
 * // 带操作按钮
 * <EmptyState
 *   icon="plus"
 *   title="暂无文档"
 *   description="创建你的第一个文档"
 *   action={<Button onClick={create}>新建文档</Button>}
 * />
 *
 * // 自定义图标
 * <EmptyState
 *   icon={<MyCustomIcon />}
 *   title="Empty"
 * />
 */

import * as React from 'react'
import { cn } from '../../utils/cn'

export type EmptyStatePresetIcon =
  | 'clock'
  | 'file'
  | 'search'
  | 'inbox'
  | 'plus'
  | 'list'

export interface EmptyStateProps {
  /** 预设图标名称或自定义 ReactNode */
  icon?: EmptyStatePresetIcon | React.ReactNode
  /** 主标题 */
  title?: React.ReactNode
  /** 描述文字 */
  description?: React.ReactNode
  /** 操作按钮（如"新建"按钮） */
  action?: React.ReactNode
  /** 尺寸：sm=紧凑 md=标准 lg=宽松 */
  size?: 'sm' | 'md' | 'lg'
  /** 布局：plain=纯内容，card=卡片空态 */
  layout?: 'plain' | 'card'
  /** 对齐方式 */
  align?: 'center' | 'start'
  /** 语义色调 */
  tone?: 'muted' | 'info' | 'success' | 'warning' | 'danger'
  /** 额外 className */
  className?: string
}

const ICON_SIZE = { sm: 40, md: 56, lg: 72 }
const PADDING = { sm: 'py-6', md: 'py-12', lg: 'py-20' }
const TITLE_SIZE = { sm: 'text-body', md: 'text-body', lg: 'text-subtitle' }
const DESC_SIZE = { sm: 'text-caption', md: 'text-body', lg: 'text-body' }

const TONE_ICON_CLASS = {
  muted: 'text-muted-foreground/20',
  info: 'text-foreground/35',
  success: 'text-success/40',
  warning: 'text-warning/45',
  danger: 'text-destructive/40',
} as const

const TONE_TITLE_CLASS = {
  muted: 'text-muted-foreground/60',
  info: 'text-foreground/75',
  success: 'text-success/90',
  warning: 'text-warning',
  danger: 'text-destructive',
} as const

const TONE_DESC_CLASS = {
  muted: 'text-muted-foreground/40',
  info: 'text-muted-foreground/60',
  success: 'text-success/80',
  warning: 'text-warning/85',
  danger: 'text-destructive/80',
} as const

const CARD_TONE_CLASS = {
  muted: 'border-dashed border-border/55 bg-muted/[0.18]',
  info: 'border-border/60 bg-muted/[0.18]',
  success: 'border-success/20 bg-success/5',
  warning: 'border-warning/20 bg-warning/5',
  danger: 'border-destructive/20 bg-destructive/5',
} as const

const CARD_ICON_BG_CLASS = {
  muted: 'bg-background/70',
  info: 'bg-background/70',
  success: 'bg-success/10',
  warning: 'bg-warning/10',
  danger: 'bg-destructive/10',
} as const

// ── 预设图标 ──

function PresetIcon({ name, size, className }: { name: EmptyStatePresetIcon; size: number; className?: string }) {
  const svgProps: React.SVGProps<SVGSVGElement> = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    className,
    'aria-hidden': true,
  }
  const strokeProps = {
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }

  switch (name) {
    case 'clock':
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="10" {...strokeProps} />
          <polyline points="12 6 12 12 16 14" {...strokeProps} />
        </svg>
      )
    case 'file':
      return (
        <svg {...svgProps}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" {...strokeProps} />
          <polyline points="14 2 14 8 20 8" {...strokeProps} />
        </svg>
      )
    case 'search':
      return (
        <svg {...svgProps}>
          <circle cx="11" cy="11" r="8" {...strokeProps} />
          <line x1="21" y1="21" x2="16.65" y2="16.65" {...strokeProps} />
        </svg>
      )
    case 'inbox':
      return (
        <svg {...svgProps}>
          <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" {...strokeProps} />
          <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" {...strokeProps} />
        </svg>
      )
    case 'plus':
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="10" {...strokeProps} />
          <line x1="12" y1="8" x2="12" y2="16" {...strokeProps} />
          <line x1="8" y1="12" x2="16" y2="12" {...strokeProps} />
        </svg>
      )
    case 'list':
      return (
        <svg {...svgProps}>
          <line x1="8" y1="6" x2="21" y2="6" {...strokeProps} />
          <line x1="8" y1="12" x2="21" y2="12" {...strokeProps} />
          <line x1="8" y1="18" x2="21" y2="18" {...strokeProps} />
          <line x1="3" y1="6" x2="3.01" y2="6" {...strokeProps} />
          <line x1="3" y1="12" x2="3.01" y2="12" {...strokeProps} />
          <line x1="3" y1="18" x2="3.01" y2="18" {...strokeProps} />
        </svg>
      )
    default:
      return null
  }
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  size = 'md',
  layout = 'plain',
  align = 'center',
  tone = 'muted',
  className,
}) => {
  const iconSize = ICON_SIZE[size]
  const centered = align === 'center'
  const cardLayout = layout === 'card'

  const renderIcon = () => {
    if (!icon) return null
    if (typeof icon === 'string') {
      return (
        <PresetIcon
          name={icon as EmptyStatePresetIcon}
          size={iconSize}
          className={TONE_ICON_CLASS[tone]}
        />
      )
    }
    return <div className={TONE_ICON_CLASS[tone]}>{icon}</div>
  }

  return (
    <div
      className={cn(
        'flex flex-col justify-center gap-2 px-4',
        PADDING[size],
        centered ? 'items-center text-center' : 'items-start text-left',
        cardLayout && 'rounded-lg border',
        cardLayout && CARD_TONE_CLASS[tone],
        className,
      )}
    >
      {icon ? (
        <div
          className={cn(
            'flex items-center justify-center',
            cardLayout && 'h-8 w-8 rounded-md',
            cardLayout && CARD_ICON_BG_CLASS[tone],
          )}
        >
          {renderIcon()}
        </div>
      ) : null}
      {title && (
        <span
          className={cn(
            'font-medium',
            TITLE_SIZE[size],
            TONE_TITLE_CLASS[tone],
          )}
        >
          {title}
        </span>
      )}
      {description && (
        <span
          className={cn(
            'max-w-[280px]',
            DESC_SIZE[size],
            TONE_DESC_CLASS[tone],
          )}
        >
          {description}
        </span>
      )}
      {action && <div className={cn('mt-2', centered ? 'self-center' : 'self-start')}>{action}</div>}
    </div>
  )
}

EmptyState.displayName = 'EmptyState'
