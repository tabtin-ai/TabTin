/**
 * 统一的控制栏组件
 *
 * 设计理念：
 * - 统一的视觉风格
 * - 清晰的按钮层级（主要/次要/辅助）
 * - 灵活的配置能力
 * - 响应式布局
 */

import React from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../utils/cn'
import { ButtonStyles, Transitions } from '../../constants/design-tokens'
import { t } from "../../i18n"

export interface ControlBarAction {
  /** 唯一标识 */
  id: string
  /** 按钮文本 */
  label: string
  /** 图标 */
  icon?: LucideIcon
  /** 点击回调 */
  onClick: () => void
  /** 按钮类型（决定视觉样式） */
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive'
  /** 是否禁用 */
  disabled?: boolean
  /** 是否加载中 */
  loading?: boolean
  /** 自定义类名 */
  className?: string
  /** 提示文本 */
  title?: string
}

export interface ControlBarProps {
  /** 主要操作（最多2个，横向排列） */
  primaryActions?: ControlBarAction[]
  /** 次要操作（多个，横向排列） */
  secondaryActions?: ControlBarAction[]
  /** 是否紧凑模式 */
  compact?: boolean
  /** 自定义类名 */
  className?: string
}

/**
 * 渲染单个按钮（简洁版）
 */
const ActionButton: React.FC<ControlBarAction> = ({
  label,
  icon: Icon,
  onClick,
  variant = 'outline',
  disabled = false,
  loading = false,
  className,
  title
}) => {
  // 视觉样式映射
  const variantStyleMap = {
    primary: ButtonStyles.primary,
    secondary: 'bg-brand-400 hover:bg-brand-500 text-white font-semibold',
    outline: ButtonStyles.outline,
    ghost: ButtonStyles.ghost,
    destructive: 'border border-destructive/40 hover:border-destructive/60 bg-background hover:bg-destructive/10 text-destructive font-medium'
  }

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      className={cn(
        // 基础样式
        'h-10 px-5 rounded-lg',
        'text-body font-medium',
        'flex items-center justify-center gap-2',
        // 过渡
        Transitions.colors,
        // 禁用状态
        'disabled:opacity-50 disabled:cursor-not-allowed',
        // 焦点样式
        'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2',
        // 变体样式
        variantStyleMap[variant],
        className
      )}
    >
      {/* 加载状态 */}
      {loading ? (
        <>
          <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          <span>{label}</span>
        </>
      ) : (
        <>
          {Icon && <Icon className="w-4 h-4" />}
          <span>{label}</span>
        </>
      )}
    </button>
  )
}

/**
 * 控制栏组件（简洁版）
 */
export const ControlBar: React.FC<ControlBarProps> = ({
  primaryActions = [],
  secondaryActions = [],
  compact = false,
  className
}) => {
  if (primaryActions.length === 0 && secondaryActions.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-3 pt-4 mt-4',
        'border-t border-border',
        compact && 'gap-2 pt-3 mt-3',
        className
      )}
    >
      {/* 主要操作区域 */}
      {primaryActions.length > 0 && (
        <div className={cn(
          'grid gap-3',
          primaryActions.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
        )}>
          {primaryActions.map((action) => (
            <ActionButton key={action.id} {...action} />
          ))}
        </div>
      )}

      {/* 次要操作区域 */}
      {secondaryActions.length > 0 && (
        <div className={cn(
          'grid gap-3',
          secondaryActions.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
        )}>
          {secondaryActions.map((action) => (
            <ActionButton key={action.id} {...action} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 预设的控制栏配置
 */
export const ControlBarPresets = {
  /**
   * 执行中状态
   */
  executing: (onCancel: () => void): ControlBarProps => ({
    primaryActions: [{
      id: 'cancel',
      label: t('controlBar.actions.cancelTask'),
      variant: 'destructive',
      onClick: onCancel
    }]
  }),

  /**
   * 暂停状态（支持恢复）
   */
  paused: (onResume: () => void, onCancel?: () => void): ControlBarProps => ({
    primaryActions: [{
      id: 'resume',
      label: t('controlBar.actions.resume'),
      variant: 'primary',
      onClick: onResume
    }],
    secondaryActions: onCancel ? [{
      id: 'cancel',
      label: t('controlBar.actions.cancelTask'),
      variant: 'ghost',
      onClick: onCancel
    }] : undefined
  }),

  /**
   * 失败状态（支持重试）
   */
  failed: (onRetry: () => void, onClose?: () => void): ControlBarProps => ({
    primaryActions: [{
      id: 'retry',
      label: t('controlBar.actions.retry'),
      variant: 'primary',
      onClick: onRetry
    }],
    secondaryActions: onClose ? [{
      id: 'close',
      label: t('common.close'),
      variant: 'ghost',
      onClick: onClose
    }] : undefined
  }),

  /**
   * 完成状态
   */
  completed: (
    onViewTable: () => void,
    onRetry: () => void,
    onClose: () => void,
  ): ControlBarProps => ({
    primaryActions: [
      {
        id: 'view',
        label: t('controlBar.actions.viewTable'),
        variant: 'primary' as const,
        onClick: onViewTable
      },
    ],
    secondaryActions: [
      {
        id: 'retry',
        label: t('controlBar.actions.retry'),
        variant: 'outline' as const,
        onClick: onRetry
      },
      {
        id: 'close',
        label: t('common.close'),
        variant: 'ghost' as const,
        onClick: onClose
      }
    ]
  })
}
