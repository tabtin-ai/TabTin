import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { RealRechargeDeliveryConfigInput } from '../api/billing-admin'

interface RealRechargeDeliveryFieldsProps {
  config: RealRechargeDeliveryConfigInput
  hasWebhookUrl: boolean
  onChange: (config: RealRechargeDeliveryConfigInput) => void
}

export function RealRechargeDeliveryFields({
  config,
  hasWebhookUrl,
  onChange,
}: RealRechargeDeliveryFieldsProps) {
  const update = (patch: Partial<RealRechargeDeliveryConfigInput>) =>
    onChange({ ...config, ...patch })

  return (
    <div className="space-y-4">
      <label className="block text-body font-medium" htmlFor="recharge-delivery-mode">
        发送方式
        <Select
          value={config.delivery_mode}
          onValueChange={(deliveryMode: RealRechargeDeliveryConfigInput['delivery_mode']) =>
            update({ delivery_mode: deliveryMode })
          }
        >
          <SelectTrigger id="recharge-delivery-mode" className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">仅手动发送</SelectItem>
            <SelectItem value="per_recharge">每笔真实充值后发送</SelectItem>
            <SelectItem value="daily">每日定时汇总</SelectItem>
          </SelectContent>
        </Select>
      </label>

      {config.delivery_mode === 'daily' ? (
        <label className="block text-body font-medium" htmlFor="recharge-delivery-time">
          每日发送时间
          <Input
            id="recharge-delivery-time"
            type="time"
            className="mt-1 w-40"
            value={config.daily_time}
            onChange={(event) => update({ daily_time: event.target.value })}
          />
          <span className="mt-1 block text-caption text-muted-foreground">
            按北京时间发送当天累计的真实充值汇总；服务短暂离线后会在恢复时补发。
          </span>
        </label>
      ) : null}

      <label className="block text-body font-medium" htmlFor="recharge-delivery-name">
        配置名称
        <Input
          id="recharge-delivery-name"
          className="mt-1"
          value={config.name}
          onChange={(event) => update({ name: event.target.value })}
          placeholder="例如：经营数据日报群"
        />
      </label>

      <label className="block text-body font-medium" htmlFor="recharge-delivery-webhook">
        Webhook 地址
        <Input
          id="recharge-delivery-webhook"
          type="password"
          className="mt-1"
          value={config.webhook_url}
          onChange={(event) => update({ webhook_url: event.target.value })}
          placeholder={hasWebhookUrl ? '已安全保存；留空表示不修改' : 'https://…'}
          autoComplete="new-password"
        />
        <span className="mt-1 block text-caption text-muted-foreground">
          接收端需要支持报表消息
          Webhook。保存后自动启用；地址会作为发送凭证加密保存，且不会再回传浏览器。
        </span>
      </label>
    </div>
  )
}
