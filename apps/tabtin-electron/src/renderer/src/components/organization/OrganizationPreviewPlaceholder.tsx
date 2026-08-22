import React from 'react'
import { Skeleton } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'

interface OrganizationPreviewPlaceholderProps {
  state: 'loading' | 'empty'
  title?: string
  description?: string
  icon?: React.ReactNode
  urlHint?: string
  className?: string
}

export const OrganizationPreviewPlaceholder: React.FC<OrganizationPreviewPlaceholderProps> = ({
  state,
  title,
  description,
  icon,
  urlHint,
  className,
}) => {
  const isLoading = state === 'loading'
  return (
    <div
      className={cn(
        'h-full flex items-center justify-center bg-muted/20 px-6 text-center',
        className
      )}
    >
      {isLoading ? (
        <div className="w-full max-w-md space-y-4" aria-hidden="true">
          <Skeleton width="100%" height={180} rounded="xl" className="bg-background/80" />
          <div className="space-y-2">
            <Skeleton width="42%" height={14} rounded="md" className="mx-auto" />
            <Skeleton width="74%" height={12} rounded="full" className="mx-auto opacity-80" />
            <Skeleton width="58%" height={12} rounded="full" className="mx-auto opacity-65" />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex justify-center">
            {icon ?? <span className="text-display">🔍</span>}
          </div>
          {title && <div className="text-foreground font-medium">{title}</div>}
          {description && (
            <div className="text-body text-muted-foreground max-w-md mx-auto">{description}</div>
          )}
          {urlHint && (
            <div className="text-body text-muted-foreground font-mono break-all max-w-md mx-auto">
              {urlHint}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
