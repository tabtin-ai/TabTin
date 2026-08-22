import React, { useCallback, useMemo } from 'react'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
} from '../select'
import { Input } from '../input'
import { cn } from '../../utils/cn'
import { t, getSmartsheetUiLocale } from '../../i18n'

// ── Types (mirrors @tabtin/table-core DateFilterValue) ──

export type DateFilterMode =
  | 'today' | 'yesterday' | 'tomorrow'
  | 'thisWeek' | 'lastWeek' | 'nextWeek'
  | 'thisMonth' | 'lastMonth' | 'nextMonth'
  | 'thisYear' | 'lastYear' | 'nextYear'
  | 'pastDays' | 'nextDays'
  | 'exactDate' | 'dateRange'

export interface DateFilterValue {
  mode: DateFilterMode
  numberOfDays?: number
  exactDate?: string
  exactDateEnd?: string
  timeZone: string
}

export interface DateFilterPickerProps {
  value: DateFilterValue | undefined
  onChange: (value: DateFilterValue) => void
  disabled?: boolean
  className?: string
}

// ── Mode metadata ──

const PRESET_MODES: DateFilterMode[] = [
  'today', 'yesterday', 'tomorrow',
  'thisWeek', 'lastWeek', 'nextWeek',
  'thisMonth', 'lastMonth', 'nextMonth',
  'thisYear', 'lastYear', 'nextYear',
]

const INPUT_MODES: DateFilterMode[] = ['pastDays', 'nextDays']
const PICKER_MODES: DateFilterMode[] = ['exactDate']
const RANGE_MODES: DateFilterMode[] = ['dateRange']

const VALID_MODES: ReadonlySet<string> = new Set<string>([
  ...PRESET_MODES, ...INPUT_MODES, ...PICKER_MODES, ...RANGE_MODES,
])

type LabelPair = { zh: string; en: string }

const MODE_LABELS: Record<DateFilterMode, LabelPair> = {
  today:     { zh: '今天', en: 'Today' },
  yesterday: { zh: '昨天', en: 'Yesterday' },
  tomorrow:  { zh: '明天', en: 'Tomorrow' },
  thisWeek:  { zh: '本周', en: 'This week' },
  lastWeek:  { zh: '上周', en: 'Last week' },
  nextWeek:  { zh: '下周', en: 'Next week' },
  thisMonth: { zh: '本月', en: 'This month' },
  lastMonth: { zh: '上月', en: 'Last month' },
  nextMonth: { zh: '下月', en: 'Next month' },
  thisYear:  { zh: '今年', en: 'This year' },
  lastYear:  { zh: '去年', en: 'Last year' },
  nextYear:  { zh: '明年', en: 'Next year' },
  pastDays:  { zh: '过去 N 天', en: 'Past N days' },
  nextDays:  { zh: '未来 N 天', en: 'Next N days' },
  exactDate: { zh: '指定日期', en: 'Exact date' },
  dateRange: { zh: '日期范围', en: 'Date range' },
}

const getDefaultTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

const getModeLabel = (mode: DateFilterMode): string => {
  const locale = getSmartsheetUiLocale()
  const lang = locale.startsWith('zh') ? 'zh' : 'en'
  return MODE_LABELS[mode]?.[lang] ?? mode
}

const isInputMode = (mode: DateFilterMode): boolean =>
  INPUT_MODES.includes(mode)

const isPickerMode = (mode: DateFilterMode): boolean =>
  PICKER_MODES.includes(mode)

const isRangeMode = (mode: DateFilterMode): boolean =>
  RANGE_MODES.includes(mode)

const DEFAULT_VALUE: DateFilterValue = {
  mode: 'today',
  timeZone: getDefaultTimeZone(),
}

// ── Component ──

export const DateFilterPicker: React.FC<DateFilterPickerProps> = React.memo(({
  value,
  onChange,
  disabled = false,
  className,
}) => {
  const currentValue = value ?? DEFAULT_VALUE
  const currentMode = currentValue.mode

  const handleModeChange = useCallback((nextMode: string) => {
    if (!VALID_MODES.has(nextMode)) return
    const mode = nextMode as DateFilterMode
    const base: DateFilterValue = {
      mode,
      timeZone: currentValue.timeZone || getDefaultTimeZone(),
    }
    if (isInputMode(mode)) {
      base.numberOfDays = currentValue.numberOfDays ?? 7
    } else if (isPickerMode(mode)) {
      base.exactDate = currentValue.exactDate ?? ''
    } else if (isRangeMode(mode)) {
      base.exactDate = currentValue.exactDate ?? ''
      base.exactDateEnd = currentValue.exactDateEnd ?? ''
    }
    onChange(base)
  }, [currentValue, onChange])

  const handleNumberChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const num = parseInt(e.target.value, 10)
    onChange({
      ...currentValue,
      numberOfDays: Number.isNaN(num) || num < 1 ? 1 : Math.min(num, 365),
    })
  }, [currentValue, onChange])

  const handleDateChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({
      ...currentValue,
      exactDate: e.target.value,
    })
  }, [currentValue, onChange])

  const handleDateEndChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({
      ...currentValue,
      exactDateEnd: e.target.value,
    })
  }, [currentValue, onChange])

  const locale = getSmartsheetUiLocale()
  const groupLabels = useMemo(() => {
    const isZh = locale.startsWith('zh')
    return {
      preset: isZh ? '预设' : 'Presets',
      days: isZh ? '天数' : 'Days',
      date: isZh ? '日期' : 'Date',
      range: isZh ? '范围' : 'Range',
    }
  }, [locale])

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      {/* Mode selector */}
      <Select
        value={currentMode}
        onValueChange={handleModeChange}
        disabled={disabled}
      >
        <SelectTrigger
          aria-label={t('dateFilter.selectMode')}
          className={cn(
            'h-8 min-w-[120px] shrink-0 rounded-[calc(var(--radius,0.6rem)-2px)] bg-muted px-2 text-body',
            isInputMode(currentMode) || isPickerMode(currentMode) || isRangeMode(currentMode)
              ? 'max-w-[140px]'
              : 'w-full',
          )}
        >
          <SelectValue placeholder={t('dateFilter.selectMode')} />
        </SelectTrigger>
        <SelectContent className="max-h-[320px]">
          <SelectGroup>
            <SelectLabel className="text-caption">{groupLabels.preset}</SelectLabel>
            {PRESET_MODES.map(mode => (
              <SelectItem key={mode} value={mode} className="text-body">
                {getModeLabel(mode)}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel className="text-caption">{groupLabels.days}</SelectLabel>
            {INPUT_MODES.map(mode => (
              <SelectItem key={mode} value={mode} className="text-body">
                {getModeLabel(mode)}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel className="text-caption">{groupLabels.date}</SelectLabel>
            {PICKER_MODES.map(mode => (
              <SelectItem key={mode} value={mode} className="text-body">
                {getModeLabel(mode)}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel className="text-caption">{groupLabels.range}</SelectLabel>
            {RANGE_MODES.map(mode => (
              <SelectItem key={mode} value={mode} className="text-body">
                {getModeLabel(mode)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      {/* Days input for pastDays / nextDays */}
      {isInputMode(currentMode) && (
        <>
          <Input
            type="number"
            min={1}
            max={365}
            value={currentValue.numberOfDays ?? ''}
            onChange={handleNumberChange}
            placeholder={t('dateFilter.daysPlaceholder')}
            aria-label={t('dateFilter.daysPlaceholder')}
            disabled={disabled}
            className="h-8 w-[72px] shrink-0 rounded-[calc(var(--radius,0.6rem)-2px)] bg-muted px-2 text-body"
          />
          {(currentMode === 'pastDays' || currentMode === 'nextDays') && (
            <span className="shrink-0 text-caption text-muted-foreground">
              {t(currentMode === 'pastDays' ? 'dateFilter.pastDaysHint' : 'dateFilter.nextDaysHint')}
            </span>
          )}
        </>
      )}

      {/* Date input for exactDate */}
      {isPickerMode(currentMode) && (
        <input
          type="date"
          required
          aria-label={t('dateFilter.exactDateLabel', { defaultValue: 'Date' })}
          value={currentValue.exactDate ?? ''}
          onChange={handleDateChange}
          disabled={disabled}
          className="flex h-8 w-full min-w-0 flex-1 rounded-[calc(var(--radius,0.6rem)-2px)] bg-muted px-2 text-body outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        />
      )}

      {/* Date range inputs */}
      {isRangeMode(currentMode) && (
        <>
          <input
            type="date"
            required
            aria-label={t('dateFilter.startDateLabel', { defaultValue: 'Start date' })}
            value={currentValue.exactDate ?? ''}
            onChange={handleDateChange}
            disabled={disabled}
            className="flex h-8 min-w-0 flex-1 rounded-[calc(var(--radius,0.6rem)-2px)] bg-muted px-2 text-body outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          />
          <span className="shrink-0 text-body text-muted-foreground">~</span>
          <input
            type="date"
            required
            aria-label={t('dateFilter.endDateLabel', { defaultValue: 'End date' })}
            value={currentValue.exactDateEnd ?? ''}
            min={currentValue.exactDate || undefined}
            onChange={handleDateEndChange}
            disabled={disabled}
            className="flex h-8 min-w-0 flex-1 rounded-[calc(var(--radius,0.6rem)-2px)] bg-muted px-2 text-body outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          />
        </>
      )}
    </div>
  )
})

DateFilterPicker.displayName = 'DateFilterPicker'
