import React from 'react'
import { StatusNotice, type StatusNoticeTone } from '@tabtin/smartsheet-ui'

export type SettingsInlineAlertTone = 'info' | 'success' | 'warning' | 'danger'

interface SettingsInlineAlertProps {
  tone?: SettingsInlineAlertTone
  title?: React.ReactNode
  description: React.ReactNode
  className?: string
}

const toneMap: Record<SettingsInlineAlertTone, StatusNoticeTone> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

export const SettingsInlineAlert: React.FC<SettingsInlineAlertProps> = ({
  tone = 'info',
  title,
  description,
  className,
}) => {
  return (
    <StatusNotice
      tone={toneMap[tone]}
      title={title}
      description={description}
      className={className}
    />
  )
}
