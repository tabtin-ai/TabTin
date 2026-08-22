/**
 * InfoBanner 组件
 *
 * 统一的信息横幅组件，用于显示提示、成功、警告、错误信息。
 * 设计：扁平风格，无阴影，使用品牌色和语义色。
 */

import React from 'react'
import { motion } from 'framer-motion'
import { Info, CheckCircle, AlertTriangle, XCircle, type LucideIcon } from 'lucide-react'
import { cn } from '../../utils/cn'
import {
  InfoColors,
  SuccessColors,
  WarningColors,
  ErrorColors,
  BorderRadius,
  BorderWidth,
  InlineSpacing,
  FontSize,
  FontWeight,
} from '../../constants/design-tokens'

export type InfoBannerType = 'info' | 'success' | 'warning' | 'error'

export interface InfoBannerProps {
  /** 横幅类型 */
  type: InfoBannerType
  /** 自定义图标（如果不提供则使用默认图标） */
  icon?: LucideIcon
  /** 标题 */
  title: string
  /** 描述文字（支持字符串或ReactNode） */
  description?: string | React.ReactNode
  /** 额外内容（放在描述下方） */
  children?: React.ReactNode
  /** 是否启用动画 */
  animate?: boolean
  /** 自定义类名 */
  className?: string
}

/**
 * 获取横幅类型对应的配置
 */
const getBannerConfig = (type: InfoBannerType) => {
  const configs = {
    info: {
      bg: InfoColors[50],
      border: InfoColors[200],
      icon: Info,
      iconColor: InfoColors[600],
      titleColor: InfoColors[900],
      textColor: InfoColors[700],
    },
    success: {
      bg: SuccessColors[50],
      border: SuccessColors[200],
      icon: CheckCircle,
      iconColor: SuccessColors[600],
      titleColor: SuccessColors[900],
      textColor: SuccessColors[700],
    },
    warning: {
      bg: WarningColors[50],
      border: WarningColors[200],
      icon: AlertTriangle,
      iconColor: WarningColors[600],
      titleColor: WarningColors[900],
      textColor: WarningColors[700],
    },
    error: {
      bg: ErrorColors[50],
      border: ErrorColors[200],
      icon: XCircle,
      iconColor: ErrorColors[600],
      titleColor: ErrorColors[900],
      textColor: ErrorColors[700],
    },
  }
  return configs[type]
}

export const InfoBanner: React.FC<InfoBannerProps> = ({
  type,
  icon,
  title,
  description,
  children,
  animate = true,
  className,
}) => {
  const config = getBannerConfig(type)
  const IconComponent = icon || config.icon

  const content = (
    <div
      className={cn(
        // 背景和边框
        config.bg,
        BorderWidth.thin,
        config.border,
        BorderRadius.md,
        // 内边距
        'p-4',
        // 自定义类名
        className
      )}
    >
      <div className={cn('flex items-start', InlineSpacing.md)}>
        {/* 图标 */}
        <IconComponent
          className={cn(
            'w-5 h-5 flex-shrink-0 mt-0.5',
            config.iconColor
          )}
        />

        {/* 内容区域 */}
        <div className="flex-1 min-w-0">
          {/* 标题 */}
          <h3
            className={cn(
              FontSize.body,
              FontWeight.semibold,
              config.titleColor,
              'mb-1'
            )}
          >
            {title}
          </h3>

          {/* 描述 */}
          {description && (
            <div
              className={cn(
                FontSize.caption,
                config.textColor,
                'leading-relaxed'
              )}
            >
              {description}
            </div>
          )}

          {/* 额外内容 */}
          {children && (
            <div className="mt-2">
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  )

  // 如果启用动画，使用 framer-motion
  if (animate) {
    return (
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        {content}
      </motion.div>
    )
  }

  return content
}
