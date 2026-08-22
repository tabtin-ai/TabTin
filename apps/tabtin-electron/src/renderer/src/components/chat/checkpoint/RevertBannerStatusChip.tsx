import type { RollbackApplyLayerStatus } from '@tabtin/chat-client'
import { AlertTriangle, CheckCircle2, Clock3 } from 'lucide-react'
import type { RevertBannerLayerChip } from './deriveRevertBannerViewModel'

export function resolveStatusChipToneClass(status: RollbackApplyLayerStatus): string {
  if (status === 'success') return 'text-success/80'
  if (status === 'partial_success') return 'text-warning/80'
  if (status === 'failed') return 'text-destructive/80'
  return 'text-muted-foreground'
}

export function resolveStatusChipIcon(status: RollbackApplyLayerStatus) {
  if (status === 'success') return CheckCircle2
  if (status === 'partial_success' || status === 'failed') return AlertTriangle
  return Clock3
}

export function StatusChip({
  label,
  detail,
  status,
}: RevertBannerLayerChip) {
  const toneClass = resolveStatusChipToneClass(status)
  const Icon = resolveStatusChipIcon(status)

  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background px-2 py-1 text-caption">
      <Icon className={`h-3 w-3 ${toneClass}`} />
      <span className="font-medium text-foreground">{label}</span>
      <span className="text-muted-foreground/80">{detail}</span>
    </span>
  )
}
