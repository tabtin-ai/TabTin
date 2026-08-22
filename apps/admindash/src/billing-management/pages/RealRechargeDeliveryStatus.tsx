import { Badge } from '@/components/ui/badge'
import type { RealRechargeDeliveryConfig } from '../api/billing-admin'

const DELIVERY_MODE_LABELS = {
  manual: '仅手动发送',
  per_recharge: '每笔真实充值后发送',
  daily: '每日定时汇总',
} as const

function formatUpdatedAt(value: string | null): string {
  if (!value) return '尚未保存'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

interface RealRechargeDeliveryStatusProps {
  savedConfig: RealRechargeDeliveryConfig
  hasUnsavedChanges: boolean
}

export function RealRechargeDeliveryStatus({
  savedConfig,
  hasUnsavedChanges,
}: RealRechargeDeliveryStatusProps) {
  const running = savedConfig.enabled && savedConfig.has_webhook_url
  const modeLabel = DELIVERY_MODE_LABELS[savedConfig.delivery_mode]
  const dailyTime = savedConfig.delivery_mode === 'daily' ? ` · 每天 ${savedConfig.daily_time}` : ''

  return (
    <div className="border bg-muted/30 p-3" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-body font-medium">当前生效配置</div>
        <div className="flex items-center gap-2">
          {hasUnsavedChanges ? <Badge variant="warning">有未保存修改</Badge> : null}
          <Badge variant={running ? 'success' : 'secondary'}>{running ? '运行中' : '未配置'}</Badge>
        </div>
      </div>
      <div className="mt-1 text-body">
        {modeLabel}
        {dailyTime} · {savedConfig.has_webhook_url ? 'Webhook 已配置' : 'Webhook 未配置'}
      </div>
      <div className="mt-1 text-caption text-muted-foreground">
        最后保存：{formatUpdatedAt(savedConfig.updated_at)}
      </div>
      {hasUnsavedChanges ? (
        <div className="mt-2 text-caption text-warning">
          当前仍按上面的配置运行；点击保存后，表单中的修改才会生效。
        </div>
      ) : null}
    </div>
  )
}
