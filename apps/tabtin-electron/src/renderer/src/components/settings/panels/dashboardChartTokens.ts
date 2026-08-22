/**
 * 仪表盘图表分类调色板（参考 shadcn/ui charts 的 --chart-1..5）。
 *
 * 集中出口：分布型/分类型条形图按类别循环取色，避免在业务组件里散写颜色。
 * 真源 token 在 globals.css（--chart-1..5）+ tailwind-preset（chart-*）。
 * 属「数据可视化」域内例外（design-system §16.2），不参与 Shell 主色。
 *
 * 阈值型指标（用量/配额/预算的「健康度」）不使用本调色板，仍走
 * neutral → warning → destructive 语义档，以传达「接近/超出上限」。
 */
export const CHART_SERIES_BAR_COLORS = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
] as const

/** 按序号循环取条形填充色（shadcn 分类色板）。 */
export function chartSeriesBarColor(index: number): string {
  return CHART_SERIES_BAR_COLORS[index % CHART_SERIES_BAR_COLORS.length]
}
