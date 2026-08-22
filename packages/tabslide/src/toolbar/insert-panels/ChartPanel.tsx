import React from 'react'
import type { PPTChartElement, ChartType } from '../../types/slides'
import * as t from '../../theme'
import { PanelWrapper, PanelSection, PanelMenuItem } from './shared'

type Translate = (key: string, options?: Record<string, unknown>) => string
const CHART_PANEL_WIDTH = 260

/* ------------------------------------------------------------------ */
/*  Chart type mini icons (16×16, matching lucide style)               */
/* ------------------------------------------------------------------ */

const iconSize = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

const ChartIcons: Record<ChartType, React.ReactNode> = {
  bar: (
    <svg {...iconSize}>
      <rect x="3" y="12" width="4" height="9" rx="1" fill="currentColor" fillOpacity={0.15} stroke="currentColor" />
      <rect x="10" y="6" width="4" height="15" rx="1" fill="currentColor" fillOpacity={0.15} stroke="currentColor" />
      <rect x="17" y="3" width="4" height="18" rx="1" fill="currentColor" fillOpacity={0.15} stroke="currentColor" />
    </svg>
  ),
  column: (
    <svg {...iconSize}>
      <rect x="3" y="14" width="4" height="7" rx="1" fill="currentColor" fillOpacity={0.15} stroke="currentColor" />
      <rect x="10" y="8" width="4" height="13" rx="1" fill="currentColor" fillOpacity={0.15} stroke="currentColor" />
      <rect x="17" y="4" width="4" height="17" rx="1" fill="currentColor" fillOpacity={0.15} stroke="currentColor" />
    </svg>
  ),
  line: (
    <svg {...iconSize}>
      <polyline points="3 17 8 11 13 14 21 6" fill="none" />
      <circle cx="3" cy="17" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="8" cy="11" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="13" cy="14" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="21" cy="6" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  area: (
    <svg {...iconSize}>
      <path d="M3 20 L3 15 L8 10 L14 14 L21 6 L21 20 Z" fill="currentColor" fillOpacity={0.12} stroke="none" />
      <polyline points="3 15 8 10 14 14 21 6" fill="none" />
    </svg>
  ),
  pie: (
    <svg {...iconSize}>
      <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity={0.08} stroke="currentColor" />
      <path d="M12 3 A9 9 0 0 1 20.5 16 L12 12 Z" fill="currentColor" fillOpacity={0.2} stroke="currentColor" />
    </svg>
  ),
  ring: (
    <svg {...iconSize}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" />
      <circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" strokeDasharray="8 24" />
      <path d="M12 3 A9 9 0 0 1 20.5 16" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
    </svg>
  ),
  radar: (
    <svg {...iconSize}>
      <polygon points="12 3 20 9 18 18 6 18 4 9" fill="currentColor" fillOpacity={0.08} stroke="currentColor" />
      <polygon points="12 7 17 10 15.5 16 8.5 16 7 10" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeDasharray="2 1" />
    </svg>
  ),
  scatter: (
    <svg {...iconSize}>
      <circle cx="6" cy="16" r="2" fill="currentColor" fillOpacity={0.25} stroke="currentColor" />
      <circle cx="10" cy="10" r="2" fill="currentColor" fillOpacity={0.25} stroke="currentColor" />
      <circle cx="15" cy="13" r="2" fill="currentColor" fillOpacity={0.25} stroke="currentColor" />
      <circle cx="18" cy="7" r="2" fill="currentColor" fillOpacity={0.25} stroke="currentColor" />
    </svg>
  ),
}

const CHART_ICON_COLORS: Record<ChartType, string> = {
  bar:     'hsl(218, 84%, 56%)',
  column:  'hsl(250, 70%, 56%)',
  line:    'hsl(160, 60%, 42%)',
  area:    'hsl(160, 60%, 42%)',
  pie:     'hsl(30, 80%, 52%)',
  ring:    'hsl(30, 80%, 52%)',
  radar:   'hsl(340, 65%, 50%)',
  scatter: 'hsl(280, 60%, 55%)',
}

/* ------------------------------------------------------------------ */
/*  Chart presets & defaults                                           */
/* ------------------------------------------------------------------ */

export const CHART_PRESETS: Array<{ type: ChartType; labelKey: string; descKey: string }> = [
  { type: 'bar', labelKey: 'insert.chart.types.bar.label', descKey: 'insert.chart.types.bar.desc' },
  { type: 'column', labelKey: 'insert.chart.types.column.label', descKey: 'insert.chart.types.column.desc' },
  { type: 'line', labelKey: 'insert.chart.types.line.label', descKey: 'insert.chart.types.line.desc' },
  { type: 'area', labelKey: 'insert.chart.types.area.label', descKey: 'insert.chart.types.area.desc' },
  { type: 'pie', labelKey: 'insert.chart.types.pie.label', descKey: 'insert.chart.types.pie.desc' },
  { type: 'ring', labelKey: 'insert.chart.types.ring.label', descKey: 'insert.chart.types.ring.desc' },
  { type: 'radar', labelKey: 'insert.chart.types.radar.label', descKey: 'insert.chart.types.radar.desc' },
  { type: 'scatter', labelKey: 'insert.chart.types.scatter.label', descKey: 'insert.chart.types.scatter.desc' },
]

export function getDefaultChartPayload(
  chartType: ChartType,
  translate: Translate,
): Pick<PPTChartElement, 'data' | 'options' | 'chartTitle'> {
  if (chartType === 'pie' || chartType === 'ring') {
    return {
      chartTitle: chartType === 'pie'
        ? translate('insert.chart.default.pieTitle')
        : translate('insert.chart.default.ringTitle'),
      data: {
        labels: [
          translate('insert.chart.default.labels.a'),
          translate('insert.chart.default.labels.b'),
          translate('insert.chart.default.labels.c'),
          translate('insert.chart.default.labels.d'),
        ],
        legends: [translate('insert.chart.default.legendShare')],
        series: [[35, 25, 20, 20]],
      },
      options: { showLegend: true, legendPosition: 'b', showDataLabel: true },
    }
  }

  if (chartType === 'radar') {
    return {
      chartTitle: translate('insert.chart.default.radarTitle'),
      data: {
        labels: [
          translate('insert.chart.default.dimension1'),
          translate('insert.chart.default.dimension2'),
          translate('insert.chart.default.dimension3'),
          translate('insert.chart.default.dimension4'),
          translate('insert.chart.default.dimension5'),
        ],
        legends: [
          translate('insert.chart.default.series1'),
          translate('insert.chart.default.series2'),
        ],
        series: [
          [80, 60, 75, 90, 70],
          [65, 82, 58, 78, 88],
        ],
      },
      options: { showLegend: true, legendPosition: 'b', showDataLabel: false },
    }
  }

  if (chartType === 'scatter') {
    return {
      chartTitle: translate('insert.chart.default.scatterTitle'),
      data: {
        labels: ['1', '2', '3', '4', '5', '6'],
        legends: [
          translate('insert.chart.default.sampleA'),
          translate('insert.chart.default.sampleB'),
        ],
        series: [
          [12, 20, 18, 30, 26, 34],
          [8, 15, 22, 24, 28, 40],
        ],
        xSeries: [
          [1, 2, 3, 4, 5, 6],
          [1.5, 2.5, 3.5, 4.5, 5.5, 6.5],
        ],
      },
      options: { showLegend: true, legendPosition: 'b', showDataLabel: false },
    }
  }

  return {
    chartTitle: chartType === 'line'
      ? translate('insert.chart.default.lineTitle')
      : chartType === 'area'
        ? translate('insert.chart.default.areaTitle')
        : translate('insert.chart.default.compareTitle'),
    data: {
      labels: ['Q1', 'Q2', 'Q3', 'Q4'],
      legends: [
        translate('insert.chart.default.series1'),
        translate('insert.chart.default.series2'),
      ],
      series: [
        [120, 132, 101, 134],
        [220, 182, 191, 234],
      ],
    },
    options: {
      showLegend: true,
      legendPosition: 'b',
      showDataLabel: false,
      stack: false,
      lineSmooth: false,
    },
  }
}

/* ------------------------------------------------------------------ */
/*  ChartPanel component                                               */
/* ------------------------------------------------------------------ */

export const ChartPanel: React.FC<{
  onInsert: (type: ChartType) => void
  translate: Translate
  width?: React.CSSProperties['width']
}> = ({ onInsert, translate, width = CHART_PANEL_WIDTH }) => (
  <PanelWrapper width={width} style={{ padding: '4px 0' }}>
    <PanelSection title={translate('insert.chart.title')}>
      {CHART_PRESETS.map((item) => (
        <PanelMenuItem
          key={item.type}
          icon={ChartIcons[item.type]}
          iconColor={CHART_ICON_COLORS[item.type]}
          label={translate(item.labelKey)}
          description={translate(item.descKey)}
          onClick={() => onInsert(item.type)}
        />
      ))}
    </PanelSection>
  </PanelWrapper>
)
