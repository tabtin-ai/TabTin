import React from 'react'
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import { cn } from '../../utils/cn'
import {
  StepPanelLayout,
  FontSize,
  FontWeight,
  ButtonStyles,
  InlineSpacing,
} from '../../constants/design-tokens'
import { t } from '../../i18n'

export interface StepHeaderProps {
  /** 步骤编号（可选） */
  stepNumber?: number
  /** 标题 */
  title: string
  /** 描述 */
  description?: string
  /** 是否允许返回 */
  canGoBack?: boolean
  /** 返回按钮文字 */
  backLabel?: string
  /** 返回回调 */
  onGoBack?: () => void
  /** 是否允许继续 */
  canContinue?: boolean
  /** 继续按钮文字 */
  nextLabel?: string
  /** 继续回调 */
  onNext?: () => void
  /** 继续按钮加载状态 */
  nextLoading?: boolean
  /** 自定义类名 */
  className?: string
  children?: React.ReactNode
}

/**
 * 通用步骤头部组件
 */
export const StepHeader: React.FC<StepHeaderProps> = ({
  stepNumber,
  title,
  description,
  canGoBack = false,
  backLabel = t('common.back'),
  onGoBack,
  canContinue = true,
  nextLabel = t('common.next'),
  onNext,
  nextLoading = false,
  className,
  children,
}) => {
  const hasActions = (canGoBack && onGoBack) || (canContinue && onNext)

  return (
    <div
      className={cn(
        'flex items-start justify-between',
        className
      )}
    >
      {/* 标题区域 */}
      <div className="flex-1 min-w-0 mr-8">
        <div className="flex items-center gap-2 mb-1">
          {stepNumber && (
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-brand-100 text-brand-600 text-body font-bold">
              {stepNumber}
            </span>
          )}
          <h2 className={cn(FontSize.title, FontWeight.semibold)}>
            {title}
          </h2>
        </div>
        {description && (
          <p className={cn(FontSize.body, 'text-muted-foreground')}>
            {description}
          </p>
        )}
      </div>

      {/* 操作区域 */}
      <div className={cn('flex items-center flex-shrink-0', InlineSpacing.md)}>
        {/* 自定义扩展内容（通常是额外的操作按钮） */}
        {children}

        {/* 返回按钮 */}
        {canGoBack && onGoBack && (
          <button
            onClick={onGoBack}
            className={cn(
              'h-9 px-4 py-2 rounded-md',
              'inline-flex items-center justify-center',
              'text-body font-medium',
              ButtonStyles.outline
            )}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {backLabel}
          </button>
        )}

        {/* 继续按钮 */}
        {canContinue && onNext && (
          <button
            onClick={onNext}
            disabled={nextLoading}
            className={cn(
              'h-9 px-4 py-2 rounded-md',
              'inline-flex items-center justify-center',
              'text-body font-medium',
              ButtonStyles.primary,
              nextLoading && 'opacity-70 cursor-not-allowed'
            )}
          >
            {nextLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t('stepHeader.loading')}
              </>
            ) : (
              <>
                {nextLabel}
                <ArrowRight className="w-4 h-4 ml-2" />
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}
