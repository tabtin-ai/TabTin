import React, { useId } from 'react'
import type { PPTLineElement, LinePoint } from '../../types/slides'
import * as t from '../../theme'
import { PanelWrapper, PanelSection, PanelGridItem } from './shared'

type Translate = (key: string, options?: Record<string, unknown>) => string

const LINE_PANEL_WIDTH = 300
const LINE_GRID_MIN_WIDTH = 44
const LINE_GRID_ITEM_SIZE = 44

export interface LineTypeOption {
  id: string
  nameKey: string
  startPoint?: LinePoint
  endPoint?: LinePoint
  startY?: number
  endY?: number
  style?: PPTLineElement['style']
  curve?: [number, number]
  broken?: [number, number]
  broken2?: [number, number]
  cubic?: [[number, number], [number, number]]
}

export const LINE_PRESETS: LineTypeOption[] = [
  { id: 'straight', nameKey: 'insert.line.presets.straight', startPoint: '', endPoint: '' },
  { id: 'singleArrow', nameKey: 'insert.line.presets.singleArrow', startPoint: '', endPoint: 'arrow' },
  { id: 'doubleArrow', nameKey: 'insert.line.presets.doubleArrow', startPoint: 'arrow', endPoint: 'arrow' },
  { id: 'diamondArrow', nameKey: 'insert.line.presets.diamondArrow', startPoint: '', endPoint: 'diamond' },
  { id: 'stealthArrow', nameKey: 'insert.line.presets.stealthArrow', startPoint: '', endPoint: 'stealth' },
  { id: 'dotEnd', nameKey: 'insert.line.presets.dotEnd', startPoint: '', endPoint: 'dot' },
  { id: 'dashed', nameKey: 'insert.line.presets.dashed', startPoint: '', endPoint: '', style: 'dashed' },
  { id: 'dashedArrow', nameKey: 'insert.line.presets.dashedArrow', startPoint: '', endPoint: 'arrow', style: 'dashed' },
  { id: 'dotted', nameKey: 'insert.line.presets.dotted', startPoint: '', endPoint: '', style: 'dotted' },
  { id: 'curve', nameKey: 'insert.line.presets.curve', startPoint: '', endPoint: 'arrow', curve: [200, -80] },
  { id: 'broken', nameKey: 'insert.line.presets.broken', startPoint: '', endPoint: 'arrow', broken: [200, -60], startY: 0, endY: 0 },
  { id: 'broken2', nameKey: 'insert.line.presets.broken2', startPoint: '', endPoint: 'arrow', broken2: [180, -60], startY: 0, endY: 0 },
  { id: 'cubic', nameKey: 'insert.line.presets.cubic', startPoint: '', endPoint: 'arrow', cubic: [[120, -80], [260, 80]] },
]

export const LinePanel: React.FC<{
  onInsert: (opt: LineTypeOption) => void
  translate: Translate
  width?: React.CSSProperties['width']
}> = ({ onInsert, translate, width = LINE_PANEL_WIDTH }) => {
  const categories: Array<{ title: string; presets: LineTypeOption[] }> = [
    {
      title: resolveCategoryLabel(translate, 'insert.line.category.basic', '基础线条', 'Basic'),
      presets: filterPresets(['straight', 'dashed', 'dotted']),
    },
    {
      title: resolveCategoryLabel(translate, 'insert.line.category.arrows', '箭头线条', 'Arrows'),
      presets: filterPresets(['singleArrow', 'doubleArrow', 'diamondArrow', 'stealthArrow', 'dotEnd', 'dashedArrow']),
    },
    {
      title: resolveCategoryLabel(translate, 'insert.line.category.paths', '路径线条', 'Paths'),
      presets: filterPresets(['curve', 'broken', 'broken2', 'cubic']),
    },
  ]

  return (
    <PanelWrapper width={width} maxHeight={420} style={{ padding: '6px 8px 10px' }}>
      {categories.map((category) => (
        <PanelSection key={category.title} title={category.title}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fit, minmax(${LINE_GRID_MIN_WIDTH}px, 1fr))`,
            justifyItems: 'center',
            gap: 4,
          }}>
            {category.presets.map((opt) => (
              <LinePresetGridItem key={opt.id} option={opt} onClick={() => onInsert(opt)} translate={translate} />
            ))}
          </div>
        </PanelSection>
      ))}
    </PanelWrapper>
  )
}

function filterPresets(ids: string[]): LineTypeOption[] {
  const idSet = new Set(ids)
  return LINE_PRESETS.filter((item) => idSet.has(item.id))
}

function resolveCategoryLabel(
  translate: Translate,
  key: string,
  zhFallback: string,
  enFallback: string,
): string {
  const translated = translate(key)
  if (translated !== key) return translated
  const lang = typeof document !== 'undefined' ? document.documentElement.lang.toLowerCase() : ''
  return lang.startsWith('zh') ? zhFallback : enFallback
}

const LINE_PATH_MAP: Record<string, string> = {
  cubic:   'M 8 20 C 28 2, 52 28, 72 10',
  broken2: 'M 8 20 L 28 4 L 50 16 L 72 8',
  curve:   'M 8 20 Q 40 2 72 20',
  broken:  'M 8 20 L 40 6 L 72 20',
}

function getLinePath(opt: LineTypeOption): string {
  if (opt.cubic) return LINE_PATH_MAP.cubic
  if (opt.broken2) return LINE_PATH_MAP.broken2
  if (opt.curve) return LINE_PATH_MAP.curve
  if (opt.broken) return LINE_PATH_MAP.broken
  return 'M 8 15 L 72 15'
}

function getDashArray(style?: PPTLineElement['style']): string | undefined {
  if (style === 'dashed') return '6 3'
  if (style === 'dotted') return '2 2'
  if (style === 'dashDot') return '6 3 2 3'
  if (style === 'longDash') return '12 3'
  if (style === 'longDashDot') return '12 3 2 3'
  return undefined
}

const LinePresetGridItem: React.FC<{
  option: LineTypeOption
  onClick: () => void
  translate: Translate
}> = ({ option, onClick, translate }) => {
  const uid = useId().replace(/[:]/g, '')
  const pathD = getLinePath(option)
  const dashArray = getDashArray(option.style)
  const mkEnd = renderLinePresetMarker(option.endPoint, false)
  const mkStart = renderLinePresetMarker(option.startPoint, true)
  const markerEndId = `lp-end-${option.id}-${uid}`
  const markerStartId = `lp-start-${option.id}-${uid}`

  return (
    <PanelGridItem onClick={onClick} title={translate(option.nameKey)} size={LINE_GRID_ITEM_SIZE}>
      <svg
        width={34}
        height={28}
        viewBox="-6 -6 92 42"
        style={{ overflow: 'visible', display: 'block', color: t.textSecondary }}
      >
        <defs>
          {mkEnd && (
            <marker
              id={markerEndId}
              markerWidth={getLinePresetMarkerConfig(option.endPoint).width}
              markerHeight={getLinePresetMarkerConfig(option.endPoint).height}
              refX={getLinePresetMarkerConfig(option.endPoint).refX}
              refY={getLinePresetMarkerConfig(option.endPoint).refY}
              orient="auto"
            >
              {mkEnd}
            </marker>
          )}
          {mkStart && (
            <marker
              id={markerStartId}
              markerWidth={getLinePresetMarkerConfig(option.startPoint).width}
              markerHeight={getLinePresetMarkerConfig(option.startPoint).height}
              refX={getLinePresetMarkerConfig(option.startPoint).startRefX}
              refY={getLinePresetMarkerConfig(option.startPoint).refY}
              orient="auto"
            >
              {mkStart}
            </marker>
          )}
        </defs>
        <path
          d={pathD}
          fill="none"
          stroke={t.textSecondary}
          strokeWidth={1.8}
          strokeDasharray={dashArray}
          strokeLinecap={option.style === 'dotted' ? 'round' : undefined}
          markerEnd={mkEnd ? `url(#${markerEndId})` : undefined}
          markerStart={mkStart ? `url(#${markerStartId})` : undefined}
        />
      </svg>
    </PanelGridItem>
  )
}

function getLinePresetMarkerConfig(point?: LinePoint) {
  if (point === 'dot') return { width: 8, height: 8, refX: 6, startRefX: 2, refY: 4 }
  if (point === 'diamond') return { width: 10, height: 10, refX: 10, startRefX: 0, refY: 5 }
  if (point === 'stealth') return { width: 10, height: 8, refX: 10, startRefX: 0, refY: 4 }
  if (point === 'triangle') return { width: 10, height: 8, refX: 10, startRefX: 0, refY: 4 }
  return { width: 10, height: 8, refX: 10, startRefX: 0, refY: 4 }
}

function renderLinePresetMarker(point?: LinePoint, start: boolean = false) {
  if (!point) return null
  if (point === 'dot') return <circle cx="4" cy="4" r="2.5" fill={t.textSecondary} />
  if (point === 'diamond') {
    return start
      ? <polygon points="10 5,5 0,0 5,5 10" fill={t.textSecondary} />
      : <polygon points="0 5,5 0,10 5,5 10" fill={t.textSecondary} />
  }
  if (point === 'stealth') {
    return start
      ? <polygon points="10 0,2.5 4,10 8,6.5 4" fill={t.textSecondary} />
      : <polygon points="0 0,7.5 4,0 8,3.5 4" fill={t.textSecondary} />
  }
  if (point === 'triangle' || point === 'arrow') {
    return start
      ? <polygon points="10 0,0 4,10 8" fill={t.textSecondary} />
      : <polygon points="0 0,10 4,0 8" fill={t.textSecondary} />
  }
  return null
}
