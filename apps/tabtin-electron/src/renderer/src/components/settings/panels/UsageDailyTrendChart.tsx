import React, { useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '@stores/useUIStore'
import { formatCreditsAuto as formatCredits } from '@/utils/formatBilling'
import type { UsageDailyTrend } from '@/types/billing'

interface Props {
  dailyTrend: UsageDailyTrend[]
  /** 后端返回的统计窗口起点（自然月 1 号，ISO date）；用于把无消费的日子补 0。 */
  windowStart?: string
}

/** 读取 globals.css 的 HSL 通道变量（如 `12 76% 61%`）并转成 echarts 可用的颜色串。 */
function cssHsl(varName: string, alpha?: number): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  if (!raw) return 'transparent'
  const channels = raw.split(/\s+/).join(', ')
  return alpha == null ? `hsl(${channels})` : `hsla(${channels}, ${alpha})`
}

/** 生成 [start, end] 闭区间内的每一天（YYYY-MM-DD），用 UTC 迭代避免时区漂移；上限 366 天兜底。 */
function eachDay(startStr: string, endStr: string): string[] {
  const out: string[] = []
  const start = new Date(`${startStr}T00:00:00Z`)
  const end = new Date(`${endStr}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return out
  let cursor = start.getTime()
  const endTime = end.getTime()
  let guard = 0
  while (cursor <= endTime && guard < 366) {
    out.push(new Date(cursor).toISOString().slice(0, 10))
    cursor += 86_400_000
    guard += 1
  }
  return out
}

interface TrendSeries {
  dates: string[]
  values: number[]
  realtimeDate: string | null
}

/** 把稀疏的 daily_trend（仅含有消费的天）铺成连续日期轴，缺失的天补 0。 */
function buildContinuousSeries(dailyTrend: UsageDailyTrend[], windowStart?: string): TrendSeries {
  const byDate = new Map<string, number>()
  let realtimeDate: string | null = null
  for (const item of dailyTrend) {
    byDate.set(item.date, Number(item.total_credits) || 0)
    if (item.is_realtime) realtimeDate = item.date
  }

  const presentDates = dailyTrend.map(d => d.date).sort()
  const clientToday = new Date().toISOString().slice(0, 10)
  const latestPresent = presentDates.length ? presentDates[presentDates.length - 1] : clientToday
  const start = windowStart?.slice(0, 10) || presentDates[0] || clientToday
  const end = latestPresent > clientToday ? latestPresent : clientToday

  const dates = eachDay(start, end)
  if (dates.length === 0) {
    // 兜底：窗口无法构造时退回原始（已排序）数据点
    return {
      dates: presentDates,
      values: presentDates.map(d => byDate.get(d) ?? 0),
      realtimeDate,
    }
  }
  return {
    dates,
    values: dates.map(d => byDate.get(d) ?? 0),
    realtimeDate,
  }
}

/** MM-DD 轴标签。 */
function toAxisLabel(isoDate: string): string {
  return isoDate.length >= 10 ? isoDate.slice(5) : isoDate
}

/**
 * 每日消费趋势折线图。
 * - 连续日期轴：窗口内没有消费的日子补 0，避免"只有一天"的错觉。
 * - 今日（后端标注 is_realtime）用 warning 色高亮，区别于已结算历史。
 * - 颜色读 globals.css 主题变量，跟随明暗主题切换。
 */
export const UsageDailyTrendChart: React.FC<Props> = ({ dailyTrend, windowStart }) => {
  const { t } = useTranslation('settings')
  // 订阅主题，主题切换时重算颜色。
  const resolvedTheme = useUIStore(state => state.resolvedTheme)

  const series = useMemo(
    () => buildContinuousSeries(dailyTrend, windowStart),
    [dailyTrend, windowStart],
  )

  const option = useMemo(() => {
    const lineColor = cssHsl('--chart-1')
    const areaTop = cssHsl('--chart-1', 0.18)
    const areaBottom = cssHsl('--chart-1', 0)
    const realtimeColor = cssHsl('--warning')
    const axisColor = cssHsl('--muted-foreground', 0.5)
    const labelColor = cssHsl('--muted-foreground')
    const splitColor = cssHsl('--border', 0.5)
    const tooltipBg = cssHsl('--popover')
    const tooltipText = cssHsl('--foreground')
    const tooltipBorder = cssHsl('--border')
    const realtimeLabel = t('usage.dailyTrend.realtime')
    const creditUnit = t('wallet.units.credits')
    const subtleText = cssHsl('--muted-foreground')

    return {
      grid: { left: 8, right: 20, top: 16, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'axis' as const,
        confine: true,
        backgroundColor: tooltipBg,
        borderColor: tooltipBorder,
        borderWidth: 1,
        padding: [6, 10],
        textStyle: { color: tooltipText, fontSize: 12 },
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : [params]
          const p = arr[0] as { name?: string; value?: number; dataIndex?: number } | undefined
          if (!p) return ''
          const date = series.dates[p.dataIndex ?? 0] ?? p.name ?? ''
          const isRealtime = date === series.realtimeDate
          const tag = isRealtime
            ? `<span style="color:${cssHsl('--warning')};margin-left:6px">${realtimeLabel}</span>`
            : ''
          const valueText = `${formatCredits(p.value ?? 0)}${creditUnit}`
          return `<div style="color:${subtleText};font-size:11px">${date}${tag}</div>`
            + `<div style="font-weight:600;font-size:13px;margin-top:2px">${valueText}</div>`
        },
      },
      xAxis: {
        type: 'category' as const,
        data: series.dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: axisColor } },
        axisTick: { show: false },
        axisLabel: {
          color: labelColor,
          fontSize: 11,
          hideOverlap: true,
          // 首尾标签贴边容易被裁；对齐进画布内侧（echarts 5.4+）。
          alignMinLabel: 'left' as const,
          alignMaxLabel: 'right' as const,
          formatter: (value: string) => toAxisLabel(value),
        },
      },
      yAxis: {
        type: 'value' as const,
        name: creditUnit.trim(),
        nameTextStyle: { color: labelColor, fontSize: 11, align: 'left' as const },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: splitColor, type: 'dashed' as const } },
        axisLabel: { color: labelColor, fontSize: 11 },
      },
      series: [
        {
          type: 'line' as const,
          data: series.values,
          smooth: true,
          showSymbol: series.values.length <= 31,
          symbolSize: 5,
          lineStyle: { color: lineColor, width: 2 },
          itemStyle: {
            color: (params: { dataIndex?: number }) => {
              const date = series.dates[params.dataIndex ?? 0]
              return date === series.realtimeDate ? realtimeColor : lineColor
            },
          },
          areaStyle: {
            color: {
              type: 'linear' as const,
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: areaTop },
                { offset: 1, color: areaBottom },
              ],
            },
          },
        },
      ],
    }
    // resolvedTheme 是「主题切换 → 重新读取 CSS 变量颜色」的触发依赖，body 内不直接引用它。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, resolvedTheme, t])

  return (
    <ReactECharts
      option={option}
      notMerge
      style={{ width: '100%', height: 180 }}
      opts={{ renderer: 'svg' }}
    />
  )
}

UsageDailyTrendChart.displayName = 'UsageDailyTrendChart'
