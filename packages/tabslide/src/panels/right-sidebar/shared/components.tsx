/**
 * TabSlide Panel Shared Components
 *
 * Thin re-export layer over @tabtin/smartsheet-ui panel primitives.
 * All components share the same borderless, compact Tailwind design
 * with design-engine and other modules.
 */

import React, { useCallback } from 'react'

// Re-export all shared panel components directly
export {
  PanelSection as Section,
  PanelDivider as SectionDivider,
  PanelTitle as Label,
  PanelFieldLabel as FieldLabel,
  PanelRow,
  PanelIconButton,
  PanelButtonGroup,
  PanelToggleButton,
  PanelInput,
  PanelSelect,
  PanelTextarea,
  PanelRangeSlider as RangeSlider,
  PanelRangeField as RangeField,
  NumberInput,
  InsertCardGrid,
  InsertCard,
  CategoryTitle,
  ColorSwatch as SharedColorSwatch,
} from '@tabtin/smartsheet-ui'

export type {
  PanelSectionProps,
  PanelDividerProps,
  PanelTitleProps,
  PanelFieldLabelProps,
  PanelRowProps,
  PanelIconButtonProps,
  PanelButtonGroupProps,
  PanelToggleButtonProps,
  PanelInputProps,
  PanelSelectProps,
  PanelTextareaProps,
  PanelRangeSliderProps,
  PanelRangeFieldProps,
  NumberInputProps,
  InsertCardGridProps,
  InsertCardProps,
  CategoryTitleProps,
} from '@tabtin/smartsheet-ui'

/* ── ToolbarIconButton — alias for PanelIconButton with md size ── */

import { PanelIconButton } from '@tabtin/smartsheet-ui'

export const ToolbarIconBtn: React.FC<{
  active?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}> = ({ active, title, onClick, children }) => (
  <PanelIconButton active={active} title={title} onClick={onClick}>
    {children}
  </PanelIconButton>
)

/* ── LayerBtn — alias for PanelIconButton with sm size ── */

export const LayerBtn: React.FC<{
  active?: boolean
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}> = ({ active, title, onClick, disabled, children }) => (
  <PanelIconButton size="sm" active={active} title={title} onClick={onClick} disabled={disabled}>
    {children}
  </PanelIconButton>
)

/* ── ColorSwatch — compat wrapper for tabslide prop interface ── */

import { ColorSwatch as SmartSheetColorSwatch } from '@tabtin/smartsheet-ui'

export interface ColorSwatchProps {
  value: string
  opacity?: number
  showOpacity?: boolean
  onChange: (hex: string, opacity?: number, themeKey?: string) => void
}

export const ColorSwatch: React.FC<ColorSwatchProps> = ({
  value,
  opacity,
  showOpacity,
  onChange,
}) => {
  const handleChange = useCallback(
    (color: string, op: number) => {
      onChange(color, showOpacity ? op : undefined)
    },
    [onChange, showOpacity],
  )

  return (
    <SmartSheetColorSwatch
      color={value || '#000000'}
      opacity={opacity ?? 1}
      onChange={handleChange}
      small
      pickerProps={{ showOpacity }}
    />
  )
}

/* ── 属性面板统一字段原语 ──
 *
 * 面板"混乱"的根因是字段没有统一规范：标签有时行内、有时在上，间距 gap-1/1.5/2 混用，
 * 颜色/滑块行各写各的内联布局，导致同一行控件顶端错位、竖向节奏不齐。
 * 这三个原语把"标签在上 + 固定间距 + 控件同高(h-7)"固化下来，凡是标签在上的字段一律走它们。
 */

/** 单个字段：标签(12px muted)固定在控件正上方，label→control 固定 4px。 */
export const FieldRow: React.FC<{
  label?: React.ReactNode
  className?: string
  children: React.ReactNode
}> = ({ label, className, children }) => (
  <div className={`flex min-w-0 flex-col gap-1${className ? ` ${className}` : ''}`}>
    {label !== undefined && label !== null && label !== '' && (
      <span className="block truncate text-caption text-muted-foreground">{label}</span>
    )}
    {children}
  </div>
)

const FIELD_GRID_COLS: Record<1 | 2 | 3 | 4, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
}

/** 字段栅格：1~4 列，行列统一 8px 间距，替代散落的 gap-1/1.5。 */
export const FieldGrid: React.FC<{
  cols?: 1 | 2 | 3 | 4
  className?: string
  children: React.ReactNode
}> = ({ cols = 1, className, children }) => (
  <div className={`grid ${FIELD_GRID_COLS[cols]} gap-2${className ? ` ${className}` : ''}`}>
    {children}
  </div>
)

/** 颜色字段：swatch + 弱化值文本，整体与输入框(h-7 muted 底)同高同料，便于与相邻控件对齐。 */
export const ColorField: React.FC<{
  value: string
  displayValue?: React.ReactNode
  /** 可选前置图标（如文本色 A / 高亮），用于在无文字标签时区分同类颜色字段。 */
  icon?: React.ReactNode
  title?: string
  opacity?: number
  showOpacity?: boolean
  onChange: (hex: string, opacity?: number, themeKey?: string) => void
}> = ({ value, displayValue, icon, title, opacity, showOpacity, onChange }) => (
  <div title={title} className="flex h-7 items-center gap-1.5 rounded bg-muted/40 px-1.5">
    {icon != null && (
      <span className="flex shrink-0 items-center justify-center text-muted-foreground/70">{icon}</span>
    )}
    <ColorSwatch value={value} opacity={opacity} showOpacity={showOpacity} onChange={onChange} />
    <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground/70 tabular-nums">
      {displayValue ?? value}
    </span>
  </div>
)

/* ── 图标优先字段/分段控件（对齐 Keynote / Sketch：图标 + 分段，替代文字标签堆叠） ── */

/**
 * IconField — 前置图标的紧凑输入药丸。图标在左传达语义（配 title tooltip），
 * 输入控件铺满其余空间，去掉"标签在上"的整行文字。
 * 借助 arbitrary variant 把内嵌 input 的自有底色/高度压平，让整块读作一个 h-7 药丸。
 * 仅压平 input（不动 select，避免抹掉 PanelSelect 的下拉箭头背景图）。
 */
export const IconField: React.FC<{
  icon: React.ReactNode
  title?: string
  className?: string
  children: React.ReactNode
}> = ({ icon, title, className, children }) => (
  <div
    title={title}
    className={`flex h-7 items-center gap-1.5 rounded bg-muted/40 pl-1.5 pr-0.5 transition-colors hover:bg-muted/60 focus-within:bg-muted/60 focus-within:ring-1 focus-within:ring-inset focus-within:ring-accent/40 [&_input]:h-6 [&_input]:w-full [&_input]:bg-transparent [&_input]:px-1 [&_input]:hover:bg-transparent [&_input]:focus:bg-transparent [&_input]:focus:ring-0${className ? ` ${className}` : ''}`}
  >
    <span className="flex shrink-0 items-center justify-center text-muted-foreground/70">{icon}</span>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
)

export interface SegmentedOption<T extends string> {
  value: T
  icon?: React.ReactNode
  label?: React.ReactNode
  title?: string
}

/** SegmentedControl — 图标/文字分段单选，替代互斥选项的下拉框（对齐 / 竖排等）。 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div className={`flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5${className ? ` ${className}` : ''}`}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={`flex h-6 flex-1 items-center justify-center rounded text-caption transition-colors ${
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {opt.icon ?? opt.label}
          </button>
        )
      })}
    </div>
  )
}
