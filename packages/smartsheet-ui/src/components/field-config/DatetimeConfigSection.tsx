import React from 'react'
import { Label } from '../label'
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '../select'
import { useTranslation } from 'react-i18next'
import type { DatetimeDateFormat, DatetimeTimeFormat } from '../../hooks/useFieldConfigForm'

export interface DatetimeConfigSectionProps {
  dateFormat: DatetimeDateFormat
  timeFormat: DatetimeTimeFormat
  timeZone: string
  onDateFormatChange: (v: DatetimeDateFormat) => void
  onTimeFormatChange: (v: DatetimeTimeFormat) => void
  onTimeZoneChange: (v: string) => void
}

const DATE_FORMAT_OPTIONS: { value: DatetimeDateFormat; label: string }[] = [
  { value: 'YYYY/MM/DD', label: 'YYYY/MM/DD' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
  { value: 'M/D/YYYY', label: 'M/D/YYYY' },
  { value: 'D/M/YYYY', label: 'D/M/YYYY' },
]

const TIME_FORMAT_OPTIONS: { value: DatetimeTimeFormat; labelKey: string }[] = [
  { value: 'HH:mm', labelKey: 'field:fieldSettingPanel.datetime.time24' },
  { value: 'HH:mm:ss', labelKey: 'field:fieldSettingPanel.datetime.time24Second' },
  { value: 'hh:mm A', labelKey: 'field:fieldSettingPanel.datetime.time12' },
  { value: 'hh:mm:ss A', labelKey: 'field:fieldSettingPanel.datetime.time12Second' },
  { value: 'None', labelKey: 'field:fieldSettingPanel.datetime.timeNone' },
]

const TIMEZONE_OPTIONS = [
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
]

export const DatetimeConfigSection: React.FC<DatetimeConfigSectionProps> = ({
  dateFormat,
  timeFormat,
  timeZone,
  onDateFormatChange,
  onTimeFormatChange,
  onTimeZoneChange,
}) => {
  const { t } = useTranslation('field')

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-body font-medium">
          {t('fieldSettingPanel.datetime.dateFormat')}
        </Label>
        <Select value={dateFormat} onValueChange={(v) => onDateFormatChange(v as DatetimeDateFormat)}>
          <SelectTrigger className="h-8 text-body">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_FORMAT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value} className="text-body">
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-body font-medium">
          {t('fieldSettingPanel.datetime.timeFormat')}
        </Label>
        <Select value={timeFormat} onValueChange={(v) => onTimeFormatChange(v as DatetimeTimeFormat)}>
          <SelectTrigger className="h-8 text-body">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIME_FORMAT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value} className="text-body">
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-body font-medium">
          {t('fieldSettingPanel.datetime.timeZone')}
        </Label>
        <Select value={timeZone} onValueChange={onTimeZoneChange}>
          <SelectTrigger className="h-8 text-body">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONE_OPTIONS.map((tz) => (
              <SelectItem key={tz} value={tz} className="text-body">
                {tz}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
