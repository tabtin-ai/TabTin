import React, { useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import type { PPTChartElement } from '../../types/slides'
import * as t from '../../theme'
import { useT } from '../../i18n'
import { buildChartOption, hasValidChartData } from '../../utils/chart-option'

interface ChartElementProps {
  element: PPTChartElement
}

const ChartElement: React.FC<ChartElementProps> = ({ element }) => {
  const translate = useT()
  const option = useMemo(() => buildChartOption(element), [element])
  const valid = useMemo(() => hasValidChartData(element), [element])

  if (!valid) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 4,
          background: element.fill || t.bgMuted,
          border: `1px dashed ${t.borderLight}`,
          borderRadius: 4,
          color: t.textTertiary,
          fontSize: 13,
        }}
      >
        <span style={{ fontSize: 20 }}>📊</span>
        <span>{element.name || `${translate('insert.chart.title')} (${element.chartType})`}</span>
        <span style={{ fontSize: 11, opacity: 0.6 }}>{translate('chart.noData')}</span>
      </div>
    )
  }

  const outlineStyle = element.outline
    ? `${element.outline.width}px ${element.outline.style} ${element.outline.color}`
    : undefined

  // key 包含尺寸信息：当 Moveable onResizeEnd 写回新的 width/height 后，
  // ECharts 实例会重新初始化，确保图表正确适配新尺寸。
  // 这比依赖 ResizeObserver 在拖拽期间的实时检测更可靠。
  const sizeKey = `${element.width}x${element.height}`

  return (
    <ReactECharts
      key={sizeKey}
      option={option}
      notMerge
      lazyUpdate={false}
      style={{
        width: '100%',
        height: '100%',
        background: element.fill || 'transparent',
        border: outlineStyle,
      }}
    />
  )
}

export default React.memo(ChartElement)
