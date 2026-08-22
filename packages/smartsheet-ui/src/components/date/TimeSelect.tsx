import * as React from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select'
import { t } from '../../i18n'
import { cn } from '../../utils/cn'
import { parseTimeString } from './utils'

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))
const SECOND_OPTIONS = MINUTE_OPTIONS

export interface TimeSelectProps {
  /** HH:mm or HH:mm:ss */
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  showSeconds?: boolean
  className?: string
  /**
   * Select 下拉 Portal 容器。传 `null` 强制挂 body（例如 Dialog 已挂 body 时）。
   * 不传则跟随 OverlayContainerContext。
   */
  portalContainer?: HTMLElement | null
}

/**
 * 小时 / 分钟双下拉，与自动化 ScheduleTimePicker 同款交互面，
 * 替代浏览器原生 `input[type=time]`。
 */
export const TimeSelect: React.FC<TimeSelectProps> = ({
  value,
  onChange,
  disabled = false,
  showSeconds = false,
  className,
  portalContainer,
}) => {
  const [hours, minutes, seconds] = parseTimeString(value)
  const hour = String(hours).padStart(2, '0')
  const minute = String(minutes).padStart(2, '0')
  const second = String(seconds).padStart(2, '0')

  const formatNextValue = (nextHour: string, nextMinute: string, nextSecond: string) =>
    showSeconds ? `${nextHour}:${nextMinute}:${nextSecond}` : `${nextHour}:${nextMinute}`

  const selectPortalProps =
    portalContainer !== undefined ? { container: portalContainer } : {}

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <Select
        value={hour}
        onValueChange={(nextHour) => onChange(formatNextValue(nextHour, minute, second))}
        disabled={disabled}
      >
        <SelectTrigger
          aria-label={t('datePicker.hour')}
          className="h-8 w-14 shrink-0 text-body"
          disabled={disabled}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent {...selectPortalProps} className="max-h-56 z-dropdown">
          {HOUR_OPTIONS.map((opt) => (
            <SelectItem key={opt} value={opt} className="justify-center px-2 text-body">
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-body text-muted-foreground" aria-hidden>
        :
      </span>
      <Select
        value={minute}
        onValueChange={(nextMinute) => onChange(formatNextValue(hour, nextMinute, second))}
        disabled={disabled}
      >
        <SelectTrigger
          aria-label={t('datePicker.minute')}
          className="h-8 w-14 shrink-0 text-body"
          disabled={disabled}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent {...selectPortalProps} className="max-h-56 z-dropdown">
          {MINUTE_OPTIONS.map((opt) => (
            <SelectItem key={opt} value={opt} className="justify-center px-2 text-body">
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {showSeconds ? (
        <>
          <span className="text-body text-muted-foreground" aria-hidden>
            :
          </span>
          <Select
            value={second}
            onValueChange={(nextSecond) => onChange(formatNextValue(hour, minute, nextSecond))}
            disabled={disabled}
          >
            <SelectTrigger
              aria-label={t('datePicker.second')}
              className="h-8 w-14 shrink-0 text-body"
              disabled={disabled}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent {...selectPortalProps} className="max-h-56 z-dropdown">
              {SECOND_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt} className="justify-center px-2 text-body">
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      ) : null}
    </div>
  )
}
