import React from 'react'
import { SHAPE_PRESETS, getShapePath } from '../../configs/shapes'
import type { ShapePreset } from '../../configs/shapes'
import * as t from '../../theme'
import { PanelWrapper, PanelSection, PanelGridItem } from './shared'

type Translate = (key: string, options?: Record<string, unknown>) => string

const SHAPE_PANEL_WIDTH = 300
const SHAPE_GRID_MIN_WIDTH = 44
const SHAPE_GRID_ITEM_SIZE = 44

const SHAPE_CATEGORY_KEY_MAP: Record<string, string> = {
  矩形: 'insertShape.category.rect',
  基础形状: 'insertShape.category.basic',
  '基础形状 2': 'insertShape.category.basic2',
  箭头: 'insertShape.category.arrows',
  星形: 'insertShape.category.stars',
}

const SHAPE_PRESET_KEY_MAP: Record<string, string> = {
  矩形: 'insertShape.presets.rect',
  圆角矩形: 'insertShape.presets.roundRect',
  单圆角矩形: 'insertShape.presets.roundRectSingle',
  剪切矩形: 'insertShape.presets.cutRect',
  椭圆: 'insertShape.presets.ellipse',
  圆形: 'insertShape.presets.circle',
  三角形: 'insertShape.presets.triangle',
  菱形: 'insertShape.presets.diamond',
  平行四边形: 'insertShape.presets.parallelogram',
  梯形: 'insertShape.presets.trapezoid',
  五边形: 'insertShape.presets.pentagon',
  六边形: 'insertShape.presets.hexagon',
  八边形: 'insertShape.presets.octagon',
  十字形: 'insertShape.presets.cross',
  直角三角形: 'insertShape.presets.rightTriangle',
  心形: 'insertShape.presets.heart',
  闪电: 'insertShape.presets.lightning',
  云形: 'insertShape.presets.cloud',
  'V 形标': 'insertShape.presets.chevron',
  标注框: 'insertShape.presets.callout',
  圆角标注框: 'insertShape.presets.roundCallout',
  右箭头: 'insertShape.presets.rightArrow',
  左箭头: 'insertShape.presets.leftArrow',
  上箭头: 'insertShape.presets.upArrow',
  下箭头: 'insertShape.presets.downArrow',
  左右双向箭头: 'insertShape.presets.leftRightArrow',
  上下双向箭头: 'insertShape.presets.upDownArrow',
  缺口右箭头: 'insertShape.presets.notchedRightArrow',
  五角星: 'insertShape.presets.star5',
  四角星: 'insertShape.presets.star4',
  六角星: 'insertShape.presets.star6',
}

function translateWithFallback(translate: Translate, key: string | undefined, fallback: string): string {
  if (!key) return fallback
  const translated = translate(key)
  return translated === key ? fallback : translated
}

export const ShapePanel: React.FC<{
  onInsert: (preset: ShapePreset) => void
  translate: Translate
  width?: React.CSSProperties['width']
}> = ({ onInsert, translate, width = SHAPE_PANEL_WIDTH }) => {
  const categories = Object.entries(SHAPE_PRESETS)

  return (
    <PanelWrapper width={width} maxHeight={420} style={{ padding: '6px 8px 10px' }}>
      {categories.map(([cat, presets]) => (
        <PanelSection
          key={cat}
          title={translateWithFallback(translate, SHAPE_CATEGORY_KEY_MAP[cat], cat)}
        >
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fit, minmax(${SHAPE_GRID_MIN_WIDTH}px, 1fr))`,
            justifyItems: 'center',
            gap: 4,
          }}>
            {presets.map((preset) => (
              <ShapePreviewBtn
                key={preset.name}
                preset={preset}
                label={translateWithFallback(translate, SHAPE_PRESET_KEY_MAP[preset.name], preset.name)}
                onClick={() => onInsert(preset)}
                size={SHAPE_GRID_ITEM_SIZE}
              />
            ))}
          </div>
        </PanelSection>
      ))}
    </PanelWrapper>
  )
}

const ShapePreviewBtn: React.FC<{ preset: ShapePreset; label: string; onClick: () => void; size: number }> = ({ preset, label, onClick, size }) => {
  const [w, h] = preset.viewBox
  const path = preset.pathFormula
    ? getShapePath(preset.pathFormula, preset.path, w, h, preset.keypoints)
    : preset.path
  // 给预览图增加安全边距，避免描边在 viewBox 边缘被裁切
  const pad = Math.max(6, Math.round(Math.max(w, h) * 0.06))
  const strokeWidth = Math.max(1.2, Math.max(w, h) * 0.024)

  return (
    <PanelGridItem onClick={onClick} title={label} size={size}>
      <svg
        width={34}
        height={28}
        viewBox={`${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ overflow: 'visible', display: 'block' }}
      >
        <path
          d={path}
          fill={t.accent}
          fillOpacity={0.15}
          stroke={t.accent}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </PanelGridItem>
  )
}
