/**
 * Alert 组件
 *
 * 统一的提示/警告/错误信息组件，用于显示各种状态反馈。
 * 设计：扁平风格，无阴影，支持动画和关闭按钮。
 */

import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Info, CheckCircle, AlertTriangle, XCircle, X, type LucideIcon } from 'lucide-react'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'
import {
  InfoColors,
  SuccessColors,
  WarningColors,
  ErrorColors,
  BorderRadius,
  BorderWidth,
  InlineSpacing,
  Transitions,
  FontSize,
} from '../../constants/design-tokens'

export type AlertType = 'info' | 'success' | 'warning' | 'error'

export interface AlertProps {
  /** 提示类型 */
  type: AlertType
  /** 标题（可选） */
  title?: string
  /** 提示内容（支持字符串或ReactNode） */
  message: string | React.ReactNode
  /** 子内容（用于自定义扩展） */
  children?: React.ReactNode
  /** 自定义图标（如果不提供则使用默认图标） */
  icon?: LucideIcon
  /** 关闭回调 */
  onClose?: () => void
  /** 是否启用动画 */
  animate?: boolean
  /** 是否显示（用于控制AnimatePresence） */
  visible?: boolean
  /** 自定义类名 */
  className?: string
}

/**
 * 获取提示类型对应的配置
 */
const getAlertConfig = (type: AlertType) => {
  const configs = {
    info: {
      bg: InfoColors[50],
      border: InfoColors[200],
      icon: Info,
      iconColor: InfoColors[600],
      textColor: InfoColors[700],
    },
    success: {
      bg: SuccessColors[50],
      border: SuccessColors[200],
      icon: CheckCircle,
      iconColor: SuccessColors[600],
      textColor: SuccessColors[700],
    },
    warning: {
      bg: WarningColors[50],
      border: WarningColors[200],
      icon: AlertTriangle,
      iconColor: WarningColors[600],
      textColor: WarningColors[700],
    },
    error: {
      bg: ErrorColors[50],
      border: ErrorColors[200],
      icon: XCircle,
      iconColor: ErrorColors[600],
      textColor: ErrorColors[700],
    },
  }
  return configs[type]
}

/**
 * Alert 组件（内部实现）
 */
const AlertContent: React.FC<AlertProps> = ({
  type,
  title,
  message,
  children,
  icon,
  onClose,
  className,
}) => {
  const config = getAlertConfig(type)
  const IconComponent = icon || config.icon

  return (
    <div
      className={cn(
        // 背景和边框
        config.bg,
        BorderWidth.thin,
        config.border,
        BorderRadius.md,
        // 内边距
        'p-3',
        // 布局
        'flex items-start',
        InlineSpacing.md,
        // 自定义类名
        className
      )}
      role="alert"
    >
      {/* 图标 */}
      <IconComponent
        className={cn(
          'w-4 h-4 flex-shrink-0 mt-0.5',
          config.iconColor
        )}
      />

      {/* 消息内容 */}
      <div className={cn('flex-1 min-w-0', FontSize.caption)}>
        {title && (
          <div className={cn('font-medium mb-1', config.textColor)}>
            {title}
          </div>
        )}
        <div className={cn(config.textColor)}>
          {message}
        </div>
        {children && (
          <div className="mt-2">
            {children}
          </div>
        )}
      </div>

      {/* 关闭按钮 */}
      {onClose && (
        <button
          onClick={onClose}
          className={cn(
            'flex-shrink-0',
            config.iconColor,
            'hover:opacity-70',
            Transitions.opacity,
            'focus:outline-none'
          )}
          aria-label={t('common.close')}
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

export const Alert: React.FC<AlertProps> = ({
  animate = true,
  visible = true,
  ...props
}) => {
  // 如果启用动画且提供了visible控制
  if (animate && props.onClose) {
    return (
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            <AlertContent {...props} />
          </motion.div>
        )}
      </AnimatePresence>
    )
  }

  // 简单动画（无visible控制）
  if (animate) {
    return (
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        <AlertContent {...props} />
      </motion.div>
    )
  }

  // 无动画
  return <AlertContent {...props} />
}
