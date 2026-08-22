/**
 * 状态徽章
 *
 * 颜色语义：
 *  - granted: 成功色（系统已授权）
 *  - denied: 警示色（用户明确拒绝，需要去设置改）
 *  - restricted: 警示色（家长控制 / MDM 限制）
 *  - not-determined: 中性（尚未询问 / 尚不确定）
 *  - pending restart confirmation: 警示色（系统层可能已授权，但当前进程需重启后确认）
 *  - detection unsupported: 中性（应用内无法自动检测）
 *  - not-applicable: 极弱化（平台无此概念）
 *  - unknown: 中性偏弱（API 调用失败）
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import type { PermissionDetection, PermissionStatus } from './permissionConfig'
import { SETTINGS_TEXT_MICRO } from '../../settingsUi'

interface Props {
  status: PermissionStatus
  detection?: PermissionDetection
  pendingRestartConfirmation?: boolean
}

const STATUS_CLASSES: Record<PermissionStatus, string> = {
  granted: 'bg-success/10 text-success border-success/20',
  denied: 'bg-warning/10 text-warning border-warning/20',
  restricted: 'bg-warning/10 text-warning border-warning/20',
  'not-determined': 'bg-muted/40 text-muted-foreground border-border/40',
  'not-applicable': 'bg-muted/25 text-muted-foreground/60 border-border/30',
  unknown: 'bg-muted/40 text-muted-foreground/80 border-border/40',
}

export const PermissionStatusBadge: React.FC<Props> = ({
  status,
  detection,
  pendingRestartConfirmation,
}) => {
  const { t } = useTranslation('settings')
  const showPendingRestart =
    pendingRestartConfirmation &&
    detection !== 'unsupported' &&
    status === 'not-determined'
  const label =
    detection === 'unsupported'
      ? t('authorizationSystem.status.detection-unsupported')
      : showPendingRestart
        ? t('authorizationSystem.status.pending-restart-confirmation')
      : t(`authorizationSystem.status.${status}`)
  return (
    <span
      className={cn(
        SETTINGS_TEXT_MICRO,
        'font-medium',
        'inline-flex items-center rounded-md border px-1.5 py-0.5',
        showPendingRestart
          ? 'bg-warning/10 text-warning border-warning/20'
          : STATUS_CLASSES[status],
      )}
      data-testid="permission-status-badge"
    >
      {label}
    </span>
  )
}
