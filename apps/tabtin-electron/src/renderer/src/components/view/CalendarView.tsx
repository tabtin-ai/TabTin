import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  ScrollBar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from '@tabtin/smartsheet-ui'
import { ChevronLeft, ChevronRight, CalendarDays, RefreshCw } from 'lucide-react'
import { useViewStore, useViewStoreApi } from '@stores/useViewStore'
import { useTableStore } from '@stores/useTableStore'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@/utils/i18n/format'
import { RecordFormContainer } from '@components/record/RecordFormContainer'
import { CollabStatus } from '@tabtin/collab-core'
import { shouldProjectViewRecordsFromCollabYdoc, useTableCollab } from '@components/table/TableCollabContext'
import { ViewLoadingOverlay, ViewPaginationBar } from './ViewShared'
import { useCalendarViewController, type CalendarEventItem } from './controller/useCalendarViewController'
import { resolveCalendarAnchorMonth } from './calendarAnchorMonth'
import { RecordCommentCountBadge } from './RecordCommentCountBadge'

// ---------------------------------------------------------------------------
// CalendarMonthGrid — 月视图网格
// ---------------------------------------------------------------------------

function toCalendarDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const CALENDAR_MAX_EVENTS_PER_CELL = 3
const CALENDAR_DAY_POPOVER_MAX_HEIGHT = 'max-h-48'
/** 与 smartsheet-ui DatePicker 日历一致，避免跳到无意义的极端年份 */
const CALENDAR_MIN_YEAR = 1900
const CALENDAR_MAX_YEAR = 2100
const CALENDAR_YEAR_SPAN = 60

interface CalendarGridCell {
  dayNum: number
  isCurrentMonth: boolean
  isToday: boolean
  dateKey: string
  events: CalendarEventItem[]
}

function parseCalendarDateKey(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const CalendarDayMorePopover: React.FC<{
  cell: CalendarGridCell
  hiddenCount: number
  onEventClick: (event: CalendarEventItem) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}> = ({ cell, hiddenCount, onEventClick, t }) => {
  const dateLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(
        parseCalendarDateKey(cell.dateKey),
      ),
    [cell.dateKey],
  )

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={e => e.stopPropagation()}
          className="truncate rounded px-1 text-left text-caption leading-4 text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground"
        >
          {t('calendar.more', { count: formatNumber(hiddenCount) })}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-56 p-2"
        onOpenAutoFocus={event => event.preventDefault()}
      >
        <p className="mb-1.5 px-1 text-caption font-medium text-foreground">
          {t('calendar.dayPopoverTitle', {
            date: dateLabel,
            count: formatNumber(cell.events.length),
          })}
        </p>
        <ScrollArea className={CALENDAR_DAY_POPOVER_MAX_HEIGHT}>
          <div className="flex flex-col gap-px pr-2">
            {cell.events.map(ev => (
              <PopoverClose asChild key={ev.id}>
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    onEventClick(ev)
                  }}
                  className="flex min-w-0 items-center gap-1 rounded bg-primary/10 px-1 py-px text-left text-caption leading-4 text-primary transition-colors hover:bg-primary/20"
                  title={ev.title}
                >
                  <span className="min-w-0 flex-1 truncate">{ev.title}</span>
                  <RecordCommentCountBadge recordId={ev.id} className="h-4 bg-background/80 px-1" />
                </button>
              </PopoverClose>
            ))}
          </div>
          <ScrollBar />
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}

const CalendarMonthGrid: React.FC<{
  events: CalendarEventItem[]
  /**
   * 控制器预计算的"按 occurrence 日期分组"映射。多日事件会在它覆盖到的每一天里都
   * 出现一次（同一 event 对象被多个日期的列表共享）。Wave 3 改条带渲染后这一项可以
   * 不再使用。
   */
  eventsByDate: Map<string, CalendarEventItem[]>
  onEventClick: (event: CalendarEventItem) => void
  onMonthChange?: (year: number, month: number) => void
  /**
   * 首次进入的锚月。为 null 时不初始化、不触发 onMonthChange，避免先拉「今天」再跳转。
   * 一旦本实例完成初始化，后续 anchorMonth 变化不再覆盖用户翻月。
   */
  anchorMonth: { year: number; month: number } | null
  hasMoreInRange?: boolean
  isLoadingMore?: boolean
  onLoadMoreRange?: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}> = ({
  events,
  eventsByDate,
  onEventClick,
  onMonthChange,
  anchorMonth,
  hasMoreInRange = false,
  isLoadingMore = false,
  onLoadMoreRange,
  t,
}) => {
  const todayRef = useMemo(() => new Date(), [])
  const [year, setYear] = useState<number | null>(null)
  const [month, setMonth] = useState<number | null>(null)
  const initializedRef = useRef(false)
  const userNavigatedRef = useRef(false)

  useEffect(() => {
    if (userNavigatedRef.current || !anchorMonth) return
    // 允许：首次初始化，或 bounds 迟到时纠正「先锚到今天」的误判（用户未翻月前）
    initializedRef.current = true
    setYear(anchorMonth.year)
    setMonth(anchorMonth.month)
  }, [anchorMonth])

  useEffect(() => {
    if (year === null || month === null) return
    onMonthChange?.(year, month)
  }, [year, month, onMonthChange])

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2025, 0, 5 + i)))
  }, [])

  const monthLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { month: 'long' })
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2024, i, 1)))
  }, [])

  const yearOptions = useMemo(() => {
    if (year === null) return []
    const from = Math.max(CALENDAR_MIN_YEAR, year - CALENDAR_YEAR_SPAN)
    const to = Math.min(CALENDAR_MAX_YEAR, year + CALENDAR_YEAR_SPAN)
    const fmt = new Intl.DateTimeFormat(undefined, { year: 'numeric' })
    return Array.from({ length: to - from + 1 }, (_, i) => {
      const value = from + i
      return { value, label: fmt.format(new Date(value, 0, 1)) }
    })
  }, [year])

  const cells = useMemo<CalendarGridCell[]>(() => {
    if (year === null || month === null) return []
    const firstDay = new Date(year, month, 1)
    const startDow = firstDay.getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const prevMonthDays = new Date(year, month, 0).getDate()
    const todayKey = toCalendarDateKey(todayRef)
    const result: CalendarGridCell[] = []

    for (let i = startDow - 1; i >= 0; i--) {
      const d = prevMonthDays - i
      const dk = toCalendarDateKey(new Date(year, month - 1, d))
      result.push({ dayNum: d, isCurrentMonth: false, isToday: dk === todayKey, dateKey: dk, events: eventsByDate.get(dk) ?? [] })
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dk = toCalendarDateKey(new Date(year, month, d))
      result.push({ dayNum: d, isCurrentMonth: true, isToday: dk === todayKey, dateKey: dk, events: eventsByDate.get(dk) ?? [] })
    }
    const remaining = 42 - result.length
    for (let d = 1; d <= remaining; d++) {
      const dk = toCalendarDateKey(new Date(year, month + 1, d))
      result.push({ dayNum: d, isCurrentMonth: false, isToday: dk === todayKey, dateKey: dk, events: eventsByDate.get(dk) ?? [] })
    }
    return result
  }, [year, month, todayRef, eventsByDate])

  const goPrev = useCallback(() => {
    if (year === null || month === null) return
    if (year <= CALENDAR_MIN_YEAR && month === 0) return
    userNavigatedRef.current = true
    if (month === 0) {
      setYear(year - 1)
      setMonth(11)
      return
    }
    setMonth(month - 1)
  }, [year, month])

  const goNext = useCallback(() => {
    if (year === null || month === null) return
    if (year >= CALENDAR_MAX_YEAR && month === 11) return
    userNavigatedRef.current = true
    if (month === 11) {
      setYear(year + 1)
      setMonth(0)
      return
    }
    setMonth(month + 1)
  }, [year, month])

  const goToday = useCallback(() => {
    userNavigatedRef.current = true
    const now = new Date()
    setYear(now.getFullYear())
    setMonth(now.getMonth())
  }, [])

  const handleYearSelect = useCallback((value: string) => {
    userNavigatedRef.current = true
    const nextYear = Number.parseInt(value, 10)
    if (Number.isNaN(nextYear)) return
    setYear(Math.min(CALENDAR_MAX_YEAR, Math.max(CALENDAR_MIN_YEAR, nextYear)))
  }, [])

  const handleMonthSelect = useCallback((value: string) => {
    userNavigatedRef.current = true
    const nextMonth = Number.parseInt(value, 10)
    if (Number.isNaN(nextMonth) || nextMonth < 0 || nextMonth > 11) return
    setMonth(nextMonth)
  }, [])

  if (year === null || month === null) {
    return null
  }

  const isViewingCurrentMonth = year === todayRef.getFullYear() && month === todayRef.getMonth()
  const canGoPrev = !(year <= CALENDAR_MIN_YEAR && month === 0)
  const canGoNext = !(year >= CALENDAR_MAX_YEAR && month === 11)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Navigation header */}
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={goPrev}
            disabled={!canGoPrev}
            aria-label={t('calendar.prevMonth')}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <ChevronLeft className="size-4" />
          </button>
          <div className="flex min-w-[160px] items-center justify-center gap-1">
            <Select value={String(year)} onValueChange={handleYearSelect}>
              <SelectTrigger
                aria-label={t('calendar.selectYear')}
                className="h-7 w-auto min-w-[4.75rem] gap-1 border-transparent bg-transparent px-2 text-subtitle font-semibold shadow-none hover:bg-accent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-dropdown max-h-56">
                {yearOptions.map(option => (
                  <SelectItem key={option.value} value={String(option.value)} className="text-body">
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={String(month)} onValueChange={handleMonthSelect}>
              <SelectTrigger
                aria-label={t('calendar.selectMonth')}
                className="h-7 w-auto min-w-[4.5rem] gap-1 border-transparent bg-transparent px-2 text-subtitle font-semibold shadow-none hover:bg-accent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-dropdown max-h-56">
                {monthLabels.map((label, index) => (
                  <SelectItem key={label} value={String(index)} className="text-body">
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <button
            type="button"
            onClick={goNext}
            disabled={!canGoNext}
            aria-label={t('calendar.nextMonth')}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <div className="flex items-center gap-3">
          {!isViewingCurrentMonth && (
            <Button variant="outline" size="sm" className="h-7 text-body" onClick={goToday}>
              {t('calendar.today')}
            </Button>
          )}
          {hasMoreInRange && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-body"
              disabled={isLoadingMore}
              onClick={onLoadMoreRange}
            >
              {isLoadingMore && <RefreshCw className="mr-1.5 size-3.5 animate-spin" />}
              {t('calendar.loadMore', { defaultValue: 'Load more' })}
            </Button>
          )}
          <span className="text-body text-muted-foreground">
            {t('calendar.summary', { count: formatNumber(events.length) })}
          </span>
        </div>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b">
        {weekdayLabels.map((label, i) => (
          <div
            key={i}
            className={cn(
              'py-1.5 text-center text-caption font-medium text-muted-foreground',
              i < 6 && 'border-r',
            )}
          >
            {label}
          </div>
        ))}
      </div>

      {/* Day cells grid */}
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {cells.map((cell, i) => (
          <div
            key={cell.dateKey}
            className={cn(
              'flex flex-col overflow-hidden p-1',
              (i + 1) % 7 !== 0 && 'border-r',
              i < 35 && 'border-b',
              !cell.isCurrentMonth && 'bg-muted/30',
            )}
          >
            <span
              className={cn(
                'mb-0.5 inline-flex size-6 shrink-0 items-center justify-center self-start rounded-full text-caption',
                cell.isToday && 'bg-primary font-semibold text-primary-foreground',
                !cell.isToday && cell.isCurrentMonth && 'text-foreground',
                !cell.isToday && !cell.isCurrentMonth && 'text-muted-foreground/40',
              )}
            >
              {cell.dayNum}
            </span>
            <div className="flex min-h-0 flex-1 flex-col gap-px overflow-hidden">
              {cell.events.slice(0, CALENDAR_MAX_EVENTS_PER_CELL).map(ev => (
                <button
                  key={ev.id}
                  onClick={e => { e.stopPropagation(); onEventClick(ev) }}
                  className="flex min-w-0 items-center gap-1 rounded bg-primary/10 px-1 py-px text-left text-caption leading-4 text-primary transition-colors hover:bg-primary/20"
                  title={ev.title}
                >
                  <span className="min-w-0 flex-1 truncate">{ev.title}</span>
                  <RecordCommentCountBadge recordId={ev.id} className="h-4 bg-background/80 px-1" />
                </button>
              ))}
              {cell.events.length > CALENDAR_MAX_EVENTS_PER_CELL && (
                <CalendarDayMorePopover
                  cell={cell}
                  hiddenCount={cell.events.length - CALENDAR_MAX_EVENTS_PER_CELL}
                  onEventClick={onEventClick}
                  t={t}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CalendarView
// ---------------------------------------------------------------------------

const CALENDAR_DATE_FIELD_TYPES = new Set([
  'date', 'created_time', 'last_modified_time',
])

const CalendarView: React.FC<{ embedded?: boolean; isReadonly?: boolean }> = ({ embedded, isReadonly = false }) => {
  const { t } = useTranslation('view')
  const { updateViewForRuntime, isCollabRuntime, collabBridge, effectiveCurrentView } = useTableCollab()
  const isTruncated = collabBridge.collab.isTruncated
  const isCollabProjectionReady =
    isCollabRuntime && collabBridge.collab.status === CollabStatus.SYNCED
  const viewStoreApi = useViewStoreApi()
  const currentViewRecords = useViewStore(s => s.currentViewRecords)
  const isRecordsLoading = useViewStore(s => s.isRecordsLoading)
  const isLoadingMoreRecords = useViewStore(s => s.isLoadingMoreRecords)
  const recordsQuery = useViewStore(s => s.recordsQuery)
  const setViewPage = useViewStore(s => s.setPage)
  const fetchViewRecords = useViewStore(s => s.fetchViewRecords)
  const loadMoreCurrentCalendarRange = useViewStore(s => s.loadMoreCurrentCalendarRange)
  const views = useViewStore(s => s.views)
  const currentViewId = useViewStore(s => s.currentViewId)
  const fields = useTableStore(s => s.fields)
  const selectedTable = useTableStore(s => s.selectedTable)

  // 协作在线时 `updateViewForRuntime` 只写 Y.Doc viewsMeta，store views 要等服务端回流
  // REST 才更新。这里用 context 暴露的 Y.Doc 派生视图替换当前视图，让配置卡 needsConfig、
  // dateField 与事件渲染口径与 grid 一致、即时刷新（ 回归修复）。
  const effectiveViews = useMemo(() => {
    if (!effectiveCurrentView || !currentViewId) return views
    return views.map(v => (v.id === currentViewId ? effectiveCurrentView : v))
  }, [views, effectiveCurrentView, currentViewId])

  const { currentView, events, groupedByDate } =
    useCalendarViewController({
      views: effectiveViews, currentViewId, currentViewRecords, fields,
      t: (key, opts) => String(t(key as any, opts as any)),
    })

  // groupedByDate 的 key 由 controller 保证是 'YYYY-MM-DD'（readWrapper 过滤了缺日期的
  // wrapper），月格直接按它取列表即可。
  const eventsByDate = useMemo(() => new Map(groupedByDate), [groupedByDate])

  const dateField = (currentView?.config as any)?.date_field
  const needsConfig = !dateField

  const todayRef = useMemo(() => new Date(), [])

  /**
   * 首次进入锚月：只用 metadata.date_bounds.max（或全空→今天）。
   * 不读 recordsQuery.date_range——新建/切视图时可能残留上一视图的「今天」窗口，
   * 会把 bounds 永久盖住（验收失败根因）。
   */
  const anchorMonth = useMemo(
    () =>
      resolveCalendarAnchorMonth({
        needsConfig,
        metadata: currentViewRecords?.metadata as Record<string, unknown> | undefined,
        isWaitingForCalendarPayload: isRecordsLoading || !currentViewRecords,
        records: currentViewRecords?.records as unknown[] | undefined,
        today: todayRef,
      }),
    [needsConfig, currentViewRecords, isRecordsLoading, todayRef],
  )

  const recordsQueryRef = useRef(recordsQuery)
  recordsQueryRef.current = recordsQuery

  const handleMonthChange = useCallback((y: number, m: number) => {
    if (!currentViewId) return
    const start = new Date(y, m, 1)
    const end = new Date(y, m + 1, 0)
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const dateRange = `${fmt(start)},${fmt(end)}`
    if (shouldProjectViewRecordsFromCollabYdoc(isCollabRuntime, isTruncated, isCollabProjectionReady)) {
      viewStoreApi.setState(state => ({
        recordsQuery: {
          ...state.recordsQuery,
          date_range: dateRange,
          page: 1,
        },
      }))
      return
    }
    void fetchViewRecords(currentViewId, {
      ...recordsQueryRef.current,
      date_range: dateRange,
      page: 1,
    })
  }, [currentViewId, fetchViewRecords, isCollabProjectionReady, isCollabRuntime, isTruncated, viewStoreApi])

  const handleLoadMoreRange = useCallback(() => {
    if (shouldProjectViewRecordsFromCollabYdoc(isCollabRuntime, isTruncated, isCollabProjectionReady)) {
      const currentPage = Math.max(1, currentViewRecords?.page ?? recordsQuery.page ?? 1)
      viewStoreApi.setState(state => ({
        recordsQuery: {
          ...state.recordsQuery,
          page: currentPage + 1,
        },
      }))
      return
    }
    void loadMoreCurrentCalendarRange()
  }, [
    currentViewRecords?.page,
    isCollabProjectionReady,
    isCollabRuntime,
    isTruncated,
    loadMoreCurrentCalendarRange,
    recordsQuery.page,
    viewStoreApi,
  ])

  const [configSelectedFieldId, setConfigSelectedFieldId] = useState<string | undefined>()
  const [isDismissed, setIsDismissed] = useState(false)
  const [isSavingConfig, setIsSavingConfig] = useState(false)

  useEffect(() => {
    setIsDismissed(false)
    setConfigSelectedFieldId(undefined)
  }, [currentViewId])

  const dateCompatibleFields = useMemo(
    () => fields.filter(f => CALENDAR_DATE_FIELD_TYPES.has(f.field_type)),
    [fields],
  )

  const handleCalendarConfigConfirm = async () => {
    if (isReadonly) return
    if (!configSelectedFieldId || !currentViewId) return
    setIsSavingConfig(true)
    try {
      const cfg = (currentView?.config ?? {}) as Record<string, unknown>
      // ：协作在线写 Y.Doc viewsMeta（与 grid 一致），否则 REST。
      await updateViewForRuntime(currentViewId, {
        config: { ...cfg, date_field: configSelectedFieldId },
      })
    } finally {
      setIsSavingConfig(false)
    }
  }

  const [selectedRecord, setSelectedRecord] = useState<any>(null)
  const [isRecordDialogOpen, setIsRecordDialogOpen] = useState(false)

  const handleEventClick = useCallback((ev: CalendarEventItem) => {
    const record = ev.raw
    setSelectedRecord({
      id: record?.id ?? ev.id,
      table_id: record?.table_id ?? selectedTable?.id ?? '',
      data: record?.data ?? ev.data ?? {},
      created_at: record?.created_at ?? '',
      updated_at: record?.updated_at ?? '',
      created_by_id: record?.created_by_id ?? '',
    })
    setIsRecordDialogOpen(true)
  }, [selectedTable?.id])

  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) { setIsRecordDialogOpen(false); setSelectedRecord(null) }
  }, [])

  const currentPage = Math.max(1, currentViewRecords?.page ?? recordsQuery.page ?? 1)
  const pageSize = Math.max(1, currentViewRecords?.page_size ?? recordsQuery.page_size ?? 100)
  const totalCount = Math.max(0, currentViewRecords?.total ?? 0)
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const hasMoreInRange = currentPage < totalPages

  if (needsConfig && !isDismissed) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-8">
        <div className="w-full max-w-sm rounded-xl border border-border/60 bg-card p-6 shadow-lg">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
              <CalendarDays className="size-5 text-primary" />
            </div>
            <div>
              <h3 className="text-body font-semibold">{t('calendar.configPrompt.title')}</h3>
              <p className="text-body text-muted-foreground">{t('calendar.configPrompt.description')}</p>
            </div>
          </div>
          {dateCompatibleFields.length === 0 ? (
            <p className="rounded-lg border border-border/40 bg-muted/30 px-4 py-6 text-center text-body text-muted-foreground">
              {t('editor.calendar.dateEmpty')}
            </p>
          ) : (
            <div className="rounded-lg border border-border/40 bg-muted/30">
              <ScrollArea className="h-52">
                <RadioGroup className="gap-0 p-1" value={configSelectedFieldId} onValueChange={setConfigSelectedFieldId}>
                  {dateCompatibleFields.map(f => (
                    <label
                      key={f.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-body transition-colors',
                        configSelectedFieldId === f.id ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent/10'
                      )}
                    >
                      <RadioGroupItem value={f.id} id={`ccfg-${f.id}`} />
                      <span className="flex-1 truncate">{f.name}</span>
                      <span className="text-caption uppercase text-muted-foreground/60">{f.field_type}</span>
                    </label>
                  ))}
                </RadioGroup>
                <ScrollBar />
              </ScrollArea>
            </div>
          )}
          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" disabled={isReadonly || !configSelectedFieldId || isSavingConfig} onClick={() => void handleCalendarConfigConfirm()} className="flex-1">
              {t('calendar.configPrompt.confirm')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIsDismissed(true)}>
              {t('calendar.configPrompt.later')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="relative flex h-full flex-col bg-background">
        {(isRecordsLoading && events.length === 0) || !anchorMonth ? (
          <ViewLoadingOverlay />
        ) : null}
        {anchorMonth ? (
          <CalendarMonthGrid
            key={currentViewId ?? 'calendar'}
            events={events}
            eventsByDate={eventsByDate}
            onEventClick={handleEventClick}
            onMonthChange={handleMonthChange}
            anchorMonth={anchorMonth}
            hasMoreInRange={hasMoreInRange}
            isLoadingMore={isLoadingMoreRecords}
            onLoadMoreRange={() => void handleLoadMoreRange()}
            t={(key, opts) => String(t(key as any, opts as any))}
          />
        ) : null}
        {!embedded && (
          <ViewPaginationBar
            currentPage={currentPage} totalPages={totalPages}
            totalCount={totalCount} isLoading={isRecordsLoading}
            onPageChange={setViewPage}
          />
        )}
      </div>

      <RecordFormContainer
        open={isRecordDialogOpen}
        onOpenChange={handleDialogOpenChange}
        mode="edit"
        record={selectedRecord ?? undefined}
        isReadonly={isReadonly}
      />
    </>
  )
}

export default CalendarView
