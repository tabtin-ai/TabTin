/**
 * UrlInput - 通用 URL 输入组件
 *
 * 用于所有需要 URL 输入的场景
 *
 * 功能：
 * - URL 输入与验证
 * - 错误提示
 * - 回车提交支持
 * - 可选的自动聚焦
 * - 可选的提示文本
 *
 * @version 1.0.0
 */

import React, { useCallback } from 'react'
import { Globe, AlertCircle } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'

export interface UrlInputProps {
  /** URL 值 */
  value: string

  /** URL 变化回调 */
  onChange: (url: string) => void

  /** 错误信息 */
  error?: string | null

  /** 占位符文本 */
  placeholder?: string

  /** 是否禁用 */
  disabled?: boolean

  /** 是否自动聚焦 */
  autoFocus?: boolean

  /** 回车键回调（如提交表单） */
  onEnter?: () => void

  /** 标签文本 */
  label?: string

  /** 是否必填（显示星号） */
  required?: boolean

  /** 提示文本（显示在输入框下方） */
  helperText?: string

  /** 样式变体 */
  variant?: 'default' | 'compact'

  /** 自定义 className */
  className?: string

  /** 聚焦环颜色 */
  focusColor?: 'brand' | 'purple'
}

/**
 * UrlInput 组件
 */
export const UrlInput: React.FC<UrlInputProps> = ({
  value,
  onChange,
  error,
  placeholder,
  disabled = false,
  autoFocus = false,
  onEnter,
  label,
  required = false,
  helperText,
  variant = 'default',
  className,
  focusColor = 'brand'
}) => {
  const { t } = useTranslation('common')
  const resolvedLabel = label ?? t('urlInput.label')
  const resolvedPlaceholder = placeholder ?? t('urlInput.placeholder')
  /**
   * 处理输入变化
   */
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value)
  }, [onChange])

  /**
   * 处理回车键
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && value.trim() && onEnter) {
      onEnter()
    }
  }, [value, onEnter])

  // 样式配置
  const isCompact = variant === 'compact'
  const labelSize = 'text-body'
  const inputSize = 'px-3 py-2 text-body'
  const iconSize = isCompact ? 'w-3.5 h-3.5' : 'w-4 h-4'
  const errorIconSize = 'w-3 h-3'
  const errorTextSize = 'text-body'
  const helperTextSize = 'text-body'

  // 聚焦环颜色
  const focusRingClass = focusColor === 'purple'
    ? 'focus:ring-2 focus:ring-purple-500 focus:border-transparent'
    : 'focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500'

  return (
    <div className={cn('space-y-2', className)}>
      {/* 标签 */}
      {resolvedLabel && (
        <label className={cn(
          'flex items-center gap-1.5 font-medium text-muted-foreground',
          labelSize
        )}>
          <Globe className={iconSize} />
          {resolvedLabel}
          {required && <span className="text-destructive">*</span>}
        </label>
      )}

      {/* 输入框 */}
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={onEnter ? handleKeyDown : undefined}
          placeholder={resolvedPlaceholder}
          disabled={disabled}
          autoFocus={autoFocus}
          className={cn(
            'w-full border rounded-lg transition-colors',
            inputSize,
            'focus:outline-none',
            focusRingClass,
    error
              ? 'border-destructive/40 bg-destructive/10'
              : 'border-border bg-background hover:border-muted-foreground/40',
            disabled && 'opacity-60 cursor-not-allowed'
          )}
        />

        {/* 错误提示 */}
        {error && (
          <div className={cn(
            'flex items-center gap-1 mt-2 text-destructive',
            errorTextSize
          )}>
            <AlertCircle className={errorIconSize} />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* 帮助文本 */}
      {helperText && !error && (
        <p className={cn('text-muted-foreground', helperTextSize)}>
          {helperText}
        </p>
      )}
    </div>
  )
}
