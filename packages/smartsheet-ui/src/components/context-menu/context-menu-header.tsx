/**
 * ContextMenuHeader 组件
 * 菜单标题栏（支持返回和关闭按钮）
 */

import React from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { cn } from '../../utils/cn'
import type { ContextMenuHeaderProps } from './types'
import { t } from "../../i18n"

export const ContextMenuHeader: React.FC<ContextMenuHeaderProps> = ({
  title,
  icon,
  onBack,
  onClose,
  extra,
  className,
}) => {
  return (
    <div className={cn('context-menu-header', className)}>
      {onBack && (
        <button
          type="button"
          className="context-menu-header__button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onBack()
          }}
          aria-label={t('common.back')}
        >
          <ArrowLeft size={16} />
        </button>
      )}

      {icon && <span className="context-menu-header__icon">{icon}</span>}

      <span className="context-menu-header__title">{title}</span>

      {extra}

      {onClose && (
        <button
          type="button"
          className="context-menu-header__button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }}
          aria-label={t('common.close')}
        >
          <X size={16} />
        </button>
      )}
    </div>
  )
}
