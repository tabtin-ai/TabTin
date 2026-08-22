import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ListFilter } from 'lucide-react'
import type { RechargePeriod, RechargePeriodKey } from './payment-order-recharge-stats'

function formatDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

interface RealRechargePeriodControlsProps {
  period: RechargePeriod
  disabled: boolean
  onChange: (period: RechargePeriod) => void
  onViewOrders: () => void
}

export function RealRechargePeriodControls({
  period,
  disabled,
  onChange,
  onViewOrders,
}: RealRechargePeriodControlsProps) {
  const selectPeriod = (key: RechargePeriodKey) => {
    if (key !== 'custom') {
      onChange({ key, startDate: '', endDate: '' })
      return
    }
    const today = new Date()
    onChange({
      key,
      startDate: formatDateInput(new Date(today.getFullYear(), today.getMonth(), 1)),
      endDate: formatDateInput(today),
    })
  }

  return (
    <div className="flex flex-col gap-3 bg-muted/20 p-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="text-body font-medium" htmlFor="real-recharge-period">
          统计时间
          <Select
            value={period.key}
            onValueChange={(value) => selectPeriod(value as RechargePeriodKey)}
          >
            <SelectTrigger id="real-recharge-period" className="mt-1 w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">今日</SelectItem>
              <SelectItem value="current_month">本月</SelectItem>
              <SelectItem value="last_30_days">近 30 天</SelectItem>
              <SelectItem value="all">全部时间</SelectItem>
              <SelectItem value="custom">自定义</SelectItem>
            </SelectContent>
          </Select>
        </label>

        {period.key === 'custom' ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="text-body font-medium" htmlFor="real-recharge-start-date">
              开始日期
              <Input
                id="real-recharge-start-date"
                type="date"
                className="mt-1 w-full sm:w-40"
                value={period.startDate}
                max={period.endDate || undefined}
                onChange={(event) => onChange({ ...period, startDate: event.target.value })}
              />
            </label>
            <label className="text-body font-medium" htmlFor="real-recharge-end-date">
              结束日期
              <Input
                id="real-recharge-end-date"
                type="date"
                className="mt-1 w-full sm:w-40"
                value={period.endDate}
                min={period.startDate || undefined}
                onChange={(event) => onChange({ ...period, endDate: event.target.value })}
              />
            </label>
          </div>
        ) : null}
      </div>

      <Button variant="secondary" onClick={onViewOrders} disabled={disabled}>
        <ListFilter className="mr-2 h-[1em] w-[1em]" />
        查看对应订单
      </Button>
    </div>
  )
}
