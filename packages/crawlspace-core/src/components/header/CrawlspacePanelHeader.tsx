/**
 * CrawlspacePanelHeader - 面板顶部栏组件
 *
 * 统一的面板顶部栏：标题 + 状态徽标 + 右侧操作（如关闭按钮）
 * 从 WorkspacePanelHeader 迁移
 */

import React, { type ReactNode } from 'react'
import { X } from 'lucide-react'
import { t } from '../../i18n'
import { cn } from '../../utils/cn'

export interface CrawlspacePanelHeaderProps {
  title: ReactNode
  description?: ReactNode
  status?: ReactNode
  onClose?: () => void
  actions?: ReactNode
  className?: string
}

/**
 * CrawlspacePanelHeader 组件
 */
export const CrawlspacePanelHeader: React.FC<CrawlspacePanelHeaderProps> = ({
  title,
  description,
  status,
  onClose,
  actions,
  className,
}) => {
  return (
    <div
      className={cn(
        'flex-none h-12 border-b border-border flex items-center justify-between px-4 bg-background/80 backdrop-blur',
        className
      )}
    >
      <div className="flex items-center gap-3 overflow-hidden">
        <div className="min-w-0">
          <div className="text-body font-medium text-foreground truncate">{title}</div>
          {description && (
            <div className="text-body text-muted-foreground truncate">{description}</div>
          )}
        </div>
        {status ? (
          <div className="flex items-center gap-2 text-body text-muted-foreground">
            {status}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        {onClose && (
          <button
            className="h-8 w-8 p-0 inline-flex items-center justify-center rounded hover:bg-accent transition-colors"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}
