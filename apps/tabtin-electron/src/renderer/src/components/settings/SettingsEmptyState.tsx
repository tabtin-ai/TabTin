import React from 'react'
import { EmptyState } from '@tabtin/smartsheet-ui'
import { Inbox } from 'lucide-react'

interface SettingsEmptyStateProps {
  title: React.ReactNode
  description?: React.ReactNode
  icon?: React.ReactNode
  className?: string
}

export const SettingsEmptyState: React.FC<SettingsEmptyStateProps> = ({
  title,
  description,
  icon,
  className,
}) => {
  return (
    <EmptyState
      icon={icon ?? <Inbox className="h-4 w-4" />}
      title={title}
      description={description}
      layout="card"
      size="sm"
      className={className}
    />
  )
}
