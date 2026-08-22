import React from 'react'
import { X } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'

interface OrganizationPanelHeaderProps {
  title: React.ReactNode
  description?: React.ReactNode
  status?: React.ReactNode
  onClose?: () => void
  actions?: React.ReactNode
  className?: string
}

/**
 * 统一的面板顶部栏：标题 + 状态徽标 + 右侧操作（如关闭按钮）
 */
export const OrganizationPanelHeader: React.FC<OrganizationPanelHeaderProps> = ({
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
        'flex-none h-12 border-b border-border flex items-center justify-between px-4 bg-background',
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
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-8 w-8 p-0"
          >
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
