import React from 'react'
import { cn } from '@utils/cn'
import type { ExecutionDeviceStatus, ExecutionDeviceStatusTone } from './terminalOverviewModel'

const TONE_CLASS: Record<ExecutionDeviceStatusTone, string> = {
  offline: 'border-warning/30 bg-warning/10 text-warning',
  remote: 'border-accent/30 bg-accent/10 text-accent',
  unbound: 'border-border/50 bg-muted/50 text-muted-foreground',
}

interface ExecutionDeviceStatusTagProps {
  status: ExecutionDeviceStatus
  className?: string
}

function StatusPill({
  label,
  tone,
  title,
}: {
  label: string
  tone: ExecutionDeviceStatusTone
  title?: string
}) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-md border px-1.5 py-0.5 text-caption font-medium leading-none',
        TONE_CLASS[tone],
      )}
      title={title}
    >
      {label}
    </span>
  )
}

/** Space 执行设备状态胶囊标签（远程 / 离线 / 未绑定） */
export const ExecutionDeviceStatusTag: React.FC<ExecutionDeviceStatusTagProps> = ({
  status,
  className,
}) => (
  <span
    className={cn('inline-flex shrink-0 items-center gap-1', className)}
    data-testid="execution-device-status-tag"
    data-tone={status.tone}
    data-secondary-tone={status.secondaryTone ?? undefined}
  >
    <StatusPill label={status.label} tone={status.tone} title={status.title} />
    {status.secondaryLabel && status.secondaryTone ? (
      <StatusPill
        label={status.secondaryLabel}
        tone={status.secondaryTone}
        title={status.title}
      />
    ) : null}
  </span>
)
