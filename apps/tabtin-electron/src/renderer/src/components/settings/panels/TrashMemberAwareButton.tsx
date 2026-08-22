import React from 'react'
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@components/ui'

/** 普通成员也展示操作，但置灰 + 悬停提示需管理员。 */
export const TrashMemberAwareButton: React.FC<{
  adminLocked: boolean
  adminHint: string
  disabled?: boolean
  onClick?: () => void
  className?: string
  children: React.ReactNode
}> = ({ adminLocked, adminHint, disabled, onClick, className, children }) => {
  const button = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || adminLocked}
      onClick={adminLocked ? undefined : onClick}
      className={className}
    >
      {children}
    </Button>
  )
  if (!adminLocked) return button
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{button}</span>
        </TooltipTrigger>
        <TooltipContent side="top">{adminHint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
