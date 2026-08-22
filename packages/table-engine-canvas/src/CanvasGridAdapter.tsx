/**
 * CanvasGridAdapter
 *
 * Adapts TabTin's TableGridRendererProps contract to Teable's Grid component.
 * This is the bridge layer that lets us use Teable's canvas grid as our rendering engine.
 *
 * Data flow:
 *   TableGridRendererProps (columns, rows, config, callbacks)
 *     → mapping →
 *   IGridProps (IGridColumn[], rowCount, getCellContent, callbacks)
 *     → Teable Grid
 */
import React, { useMemo, useCallback, useRef, useEffect, useLayoutEffect, useState, forwardRef, useImperativeHandle } from 'react'
import { renderToString } from 'react-dom/server'
import type { DateFieldOptionsLike } from '@tabtin/smartsheet-ui'
import { resolveSelectChipColors } from '@tabtin/smartsheet-ui'
import {
  A as TextFieldIcon,
  Calendar as CalendarFieldIcon,
  CheckCircle2 as SelectFieldIcon,
  CheckSquare as CheckboxFieldIcon,
  Clock4 as TimeFieldIcon,
  Code as FormulaFieldIcon,
  DollarSign as CurrencyFieldIcon,
  File as AttachmentFieldIcon,
  Hash as NumberFieldIcon,
  Image as ImageFieldIcon,
  Layers as RollupFieldIcon,
  Link as LinkFieldIcon,
  ListChecks as MultiSelectFieldIcon,
  LongText as LongTextFieldIcon,
  Mail as EmailFieldIcon,
  Percent as PercentFieldIcon,
  Phone as PhoneFieldIcon,
  Search as LookupFieldIcon,
  Star as RatingFieldIcon,
  User as UserFieldIcon,
} from './icons/inlineIcons'
import {
  resolveRecordId,
  type TableGridRendererProps,
  type TableGridRow,
  type TableGridColumn,
  type TableGridRuntimeApi,
  type TableGridEngine,
  type TableGridCanvasFieldMenuLabels,
  type TableGridCanvasRecordMenuLabels,
  type TableGridCanvasStatisticMenuLabels,
  type TableGridCanvasEditorLabels,
  type TableGridCanvasOverlayConfig,
  type TableGridAttachmentAccessContext,
  type TableGridSortModelItem,
} from '@tabtin/table-engine'
import { useDebounce } from 'react-use'
import { resolveUserDisplay, type UserDisplayResolution } from './userDisplayName'

/**
 * 人员字段（user / created_by / last_modified_by）的可见文案。
 *
 * 离组成员保留离开时的姓名并标注状态，让人一眼看出这人已经不在组织里 —— 只显示姓名会
 * 让人以为还能派活给他。查不到的 ID 说「未知」而不是「已离开成员」：这个 ID 可能从来
 * 没对应过任何用户（脏数据、误写、跨组织残留），断言他"离开过"是在编造事实。
 *
 * 任何分支都不回落成用户 ID，连截断片段也不行 —— 内部标识不上屏。
 */
const DEPARTED_MEMBER_SUFFIX = '（已离职）'
const UNKNOWN_MEMBER_LABEL = '未知'

function userDisplayLabel(resolution: UserDisplayResolution): string {
  switch (resolution.kind) {
    case 'departed':
      return `${resolution.displayName}${DEPARTED_MEMBER_SUFFIX}`
    case 'unknown':
      return UNKNOWN_MEMBER_LABEL
    default:
      return resolution.displayName
  }
}

import { Grid, type IGridRef } from './grid/Grid'
import type { IGridTheme } from './grid/configs'
import type {
  IGridColumn,
  ICellItem,
  ICell,
  IRowControlItem,
  IColumnStatistics,
  IColumnStatistic,
  IRectangle,
  IPosition,
  IGroupPoint,
  IGroupCollection,
  ILinearRow,
  IRange,
  IRowTreeData,
} from './grid/interface'
import {
  RowControlType,
  LinearRowType,
  DraggableType,
} from './grid/interface'
import {
  CellType,
  type ITextCell,
  type INumberCell,
  type IBooleanCell,
  type ISelectCell,
  type ISelectChoice,
  type ISelectChoiceSorted,
  type IRatingCell,
  type IImageCell,
  type IImageData,
  type ILinkCell,
  type ILinkCellValue,
  type IUserCell,
  type IUserData,
  type IInnerCell,
} from './grid/renderers/cell-renderer/interface'
import type { IEditorRef, IEditorProps } from './grid/components/editor/EditorContainer'
import type {
  AttachmentPreviewDialogRef,
  AttachmentPreviewFile,
  AttachmentPreviewUi,
} from './grid/components/editor/GridAttachmentEditor'
import {
  clampEditorHeight,
  getMaxEditorHeight,
  LONG_TEXT_EDITOR_MIN_HEIGHT,
} from './grid/components/editor/editorHeight'
import type { ISpriteMap } from './grid/managers'
import { CombinedSelection } from './grid/managers'
import { RegionType, SelectionRegionType } from './grid/interface'
import type { ICollaborator } from './grid/interface'
import { useGridOverlayStore, type IRecordMenuData } from './overlays/store'
import { defaultStatLabels } from './overlays/statistics'
import { PREFILLING_HEADER_HEIGHT } from './overlays/PrefillingRowContainer'
import {
  getRecordMenuRowId,
  resolveAppendDisplayRowIndex,
  resolveCellSelectionStateForRecordMenu,
  resolveDisplayRowIndexForRecordMenu,
  resolveRowSelectionStateForRecordMenu,
  resolveRealRowIndexFromDisplayIndex,
} from './recordMenuUtils'
import { normalizeUrlCellHref } from './utils/normalizeUrlCellHref'
import { shouldIncludeClipboardHeaders } from './clipboardHeaders'
import {
  resolveLinkRecordDisplayTitle,
  resolvePrimaryFieldRecordTitle,
  resolveSubRecordParentLinkTitle,
} from './linkRecordDisplay'
import {
  isTransientAttachmentValueOnly,
  sanitizeAttachmentValueForPersistence,
} from './grid/utils/attachmentPersistence'

function createDeferredComponent(
  load: () => Promise<{ default: React.ComponentType<any> }>,
  displayName: string,
) {
  const DeferredComponent = (props: any) => {
    const [Loaded, setLoaded] = useState<React.ComponentType<any> | null>(null)

    useEffect(() => {
      let active = true
      void load().then((module) => {
        if (!active) return
        setLoaded(() => module.default)
      })
      return () => {
        active = false
      }
    }, [])

    if (!Loaded) return null
    return React.createElement(Loaded, props)
  }

  DeferredComponent.displayName = displayName
  return DeferredComponent
}

const COLUMN_RESIZE_MOVE_SUPPRESS_MS = 500

function createDeferredForwardRefComponent(
  load: () => Promise<{ default: React.ComponentType<any> }>,
  displayName: string,
) {
  const DeferredComponent = forwardRef<any, any>((props, ref) => {
    const [Loaded, setLoaded] = useState<React.ComponentType<any> | null>(null)

    useEffect(() => {
      let active = true
      void load().then((module) => {
        if (!active) return
        setLoaded(() => module.default)
      })
      return () => {
        active = false
      }
    }, [])

    if (!Loaded) return null
    return React.createElement(Loaded, { ...props, ref })
  })

  DeferredComponent.displayName = displayName
  return DeferredComponent
}

const DeferredGridDateEditor = createDeferredForwardRefComponent(
  () => import('./grid/components/editor/GridDateEditor').then((module) => ({ default: module.GridDateEditor as React.ComponentType<any> })),
  'DeferredGridDateEditor',
)

const DeferredGridAttachmentEditor = createDeferredForwardRefComponent(
  () => import('./grid/components/editor/GridAttachmentEditor').then((module) => ({ default: module.GridAttachmentEditor as React.ComponentType<any> })),
  'DeferredGridAttachmentEditor',
)

const DeferredGridUserEditor = createDeferredForwardRefComponent(
  () => import('./grid/components/editor/GridUserEditor').then((module) => ({ default: module.GridUserEditor as React.ComponentType<any> })),
  'DeferredGridUserEditor',
)

type OrganizationMemberOption = { id: string; name: string; email?: string; avatarUrl?: string }

// ── long_text 多行文本编辑器 ──────────────────────────────────────────────
// 使用 textarea 替代单行 input，Enter 换行、Cmd/Ctrl+Enter 提交、Escape 取消。
// 高度策略与 TextEditor（isWrap）对齐：封顶 40vh（至少 320），超出内部滚动，
// 避免粘贴长 Markdown 时按 scrollHeight 无限增高撑爆可视区。
interface IGridLongTextEditorProps extends IEditorProps {
  value?: string | null
}

const GridLongTextEditor = forwardRef<IEditorRef, IGridLongTextEditorProps>(
  (props, ref) => {
    const { value, rect, style, theme, isEditing, setEditing, onChange } = props
    const { width, height } = rect
    const { cellLineColorActived } = theme
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const [textValue, setTextValue] = useState(value ?? '')
    const textValueRef = useRef(textValue)
    textValueRef.current = textValue
    const maxEditorHeight = getMaxEditorHeight()
    // The DOM editor replaces the expanded canvas preview while editing, so it
    // must cover the same minimum height instead of exposing that preview below.
    const minEditorHeight = Math.max(LONG_TEXT_EDITOR_MIN_HEIGHT, height)

    useEffect(() => {
      setTextValue(value ?? '')
    }, [value])

    useImperativeHandle(ref, () => ({
      focus: () => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        const len = el.value.length
        el.selectionStart = len
        el.selectionEnd = len
      },
      setValue: (data: unknown) => {
        const v = data == null ? '' : String(data)
        setTextValue(v)
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (!el) return
          const len = el.value.length
          el.selectionStart = len
          el.selectionEnd = len
        })
      },
      saveValue: () => {
        onChange?.(textValueRef.current)
      },
    }))

    useEffect(() => {
      if (isEditing) {
        const el = textareaRef.current
        if (el) {
          el.focus()
          el.selectionStart = el.value.length
          el.selectionEnd = el.value.length
        }
      }
    }, [isEditing])

    useEffect(() => {
      const el = textareaRef.current
      if (!el) return
      const cap = getMaxEditorHeight()
      el.style.height = '0px'
      const contentHeight = el.scrollHeight
      el.style.height = `${clampEditorHeight(contentHeight, minEditorHeight, cap)}px`
      el.style.overflowY = contentHeight > cap ? 'auto' : 'hidden'
    }, [textValue, minEditorHeight])

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
          e.stopPropagation()
          return
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
          e.preventDefault()
          e.stopPropagation()
          onChange?.(textValueRef.current)
          setEditing?.(false)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setEditing?.(false)
        }
      },
      [onChange, setEditing],
    )

    return (
      <textarea
        ref={textareaRef}
        value={textValue}
        style={{
          ...style,
          width: width + 4,
          minHeight: minEditorHeight,
          maxHeight: maxEditorHeight,
          marginLeft: -1.5,
          marginTop: -2,
          border: `2px solid ${cellLineColorActived}`,
          resize: 'none',
          overflow: 'auto',
        }}
        className="absolute left-0 top-0 w-full rounded-md bg-background px-2 py-1 text-body shadow-none outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        onChange={(e) => setTextValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      />
    )
  },
)
GridLongTextEditor.displayName = 'GridLongTextEditor'

const DeferredRecordMenu = createDeferredComponent(
  () => import('./overlays/RecordMenu').then((module) => ({ default: module.RecordMenu as React.ComponentType<any> })),
  'DeferredRecordMenu',
)

const DeferredFieldMenu = createDeferredComponent(
  () => import('./overlays/FieldMenu').then((module) => ({ default: module.FieldMenu as React.ComponentType<any> })),
  'DeferredFieldMenu',
)

const DeferredStatisticMenu = createDeferredComponent(
  () => import('./overlays/StatisticMenu').then((module) => ({ default: module.StatisticMenu as React.ComponentType<any> })),
  'DeferredStatisticMenu',
)

let overlayOwnerIdSequence = 0

const DeferredPrefillingRowContainer = createDeferredComponent(
  () => import('./overlays/PrefillingRowContainer').then((module) => ({ default: module.PrefillingRowContainer as React.ComponentType<any> })),
  'DeferredPrefillingRowContainer',
)

const DeferredDescriptionTooltip = createDeferredComponent(
  () => import('./overlays/DescriptionTooltip').then((module) => ({ default: module.DescriptionTooltip as React.ComponentType<any> })),
  'DeferredDescriptionTooltip',
)

// ---------------------------------------------------------------------------
// Select choice colors — 保存原色背景 + 可读字色（见 resolveSelectChipColors）
// ---------------------------------------------------------------------------
function getFallbackChoiceColor(name: string): { color: string; backgroundColor: string } {
  return resolveSelectChipColors({ value: name, label: name })
}

// ---------------------------------------------------------------------------
// Field type → column icon mapping
// ---------------------------------------------------------------------------
const FIELD_TYPE_ICON_MAP: Record<string, string> = {
  text: 'text',
  single_line_text: 'text',
  long_text: 'align-left',
  number: 'hash',
  currency: 'dollar-sign',
  percent: 'percent',
  single_select: 'list',
  select: 'list',
  multi_select: 'list-checks',
  date: 'calendar',
  created_time: 'clock',
  last_modified_time: 'clock',
  checkbox: 'check-square',
  boolean: 'check-square',
  rating: 'star',
  attachment: 'paperclip',
  url: 'link',
  email: 'mail',
  phone: 'phone',
  user: 'user',
  created_by: 'user',
  last_modified_by: 'user',
  count: 'sigma',
  link: 'link-2',
}

type SvgIconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>

const FIELD_HEADER_ICON_COMPONENT_MAP: Record<string, SvgIconComponent> = {
  text: TextFieldIcon,
  'align-left': LongTextFieldIcon,
  hash: NumberFieldIcon,
  'dollar-sign': CurrencyFieldIcon,
  percent: PercentFieldIcon,
  list: SelectFieldIcon,
  'list-checks': MultiSelectFieldIcon,
  calendar: CalendarFieldIcon,
  clock: TimeFieldIcon,
  'check-square': CheckboxFieldIcon,
  star: RatingFieldIcon,
  paperclip: AttachmentFieldIcon,
  image: ImageFieldIcon,
  link: LinkFieldIcon,
  'link-2': LinkFieldIcon,
  mail: EmailFieldIcon,
  phone: PhoneFieldIcon,
  user: UserFieldIcon,
  sigma: RollupFieldIcon,
  layers: RollupFieldIcon,
  'function-square': FormulaFieldIcon,
  search: LookupFieldIcon,
}

const createSpriteFromIcon = (IconComponent: SvgIconComponent) => ({
  fgColor,
}: {
  fgColor: string
  bgColor: string
}) => renderToString(<IconComponent style={{ color: fgColor }} />)

const createFieldHeaderSpriteMap = (): ISpriteMap => {
  const entries = Object.entries(FIELD_HEADER_ICON_COMPONENT_MAP).map(
    ([iconKey, IconComponent]) =>
      [iconKey, createSpriteFromIcon(IconComponent)] as const
  )
  return Object.fromEntries(entries) as ISpriteMap
}

let _cachedFieldHeaderSpriteMap: ISpriteMap | undefined
function getFieldHeaderSpriteMap(): ISpriteMap {
  if (!_cachedFieldHeaderSpriteMap) {
    _cachedFieldHeaderSpriteMap = createFieldHeaderSpriteMap()
  }
  return _cachedFieldHeaderSpriteMap
}

const resolveCssVarToken = (
  styleDeclaration: CSSStyleDeclaration,
  variableName: string,
  fallbackToken: string
): string => {
  const token = styleDeclaration.getPropertyValue(variableName).trim()
  return token || fallbackToken
}

const hslToken = (token: string, alpha?: number): string => {
  if (alpha == null) {
    return `hsl(${token})`
  }
  return `hsl(${token} / ${alpha})`
}

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const parseCssNumber = (
  rawValue: string,
  fallback: number,
  options?: { min?: number; max?: number }
): number => {
  const parsed = Number.parseFloat(rawValue)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  const min = options?.min ?? Number.NEGATIVE_INFINITY
  const max = options?.max ?? Number.POSITIVE_INFINITY
  return clampNumber(parsed, min, max)
}

const reorderByDragIndexes = <T,>(
  source: T[],
  dragIndexes: number[],
  dropIndex: number
): T[] => {
  if (source.length === 0 || dragIndexes.length === 0) {
    return source
  }

  const normalizedDragIndexes = Array.from(
    new Set(
      dragIndexes
        .map(index => Math.floor(index))
        .filter(index => Number.isFinite(index) && index >= 0 && index < source.length)
    )
  ).sort((left, right) => left - right)

  if (normalizedDragIndexes.length === 0) {
    return source
  }

  const dragIndexSet = new Set(normalizedDragIndexes)
  const movingItems = source.filter((_item, index) => dragIndexSet.has(index))
  const remainingItems = source.filter((_item, index) => !dragIndexSet.has(index))

  const clampedDropIndex = Math.max(0, Math.min(Math.floor(dropIndex), source.length))
  const removedBeforeDrop = normalizedDragIndexes.reduce(
    (count, index) => (index < clampedDropIndex ? count + 1 : count),
    0
  )
  const insertIndex = Math.max(
    0,
    Math.min(clampedDropIndex - removedBeforeDrop, remainingItems.length)
  )

  return [
    ...remainingItems.slice(0, insertIndex),
    ...movingItems,
    ...remainingItems.slice(insertIndex),
  ]
}

const buildCanvasThemeFromCssVars = (
  resolvedTheme: 'light' | 'dark'
): Partial<IGridTheme> | undefined => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return undefined
  }

  const rootStyle = window.getComputedStyle(document.documentElement)
  const isDark = resolvedTheme === 'dark'

  const backgroundToken = resolveCssVarToken(
    rootStyle,
    '--background',
    isDark ? '224 18% 12%' : '0 0% 100%'
  )
  const foregroundToken = resolveCssVarToken(
    rootStyle,
    '--foreground',
    isDark ? '210 40% 98%' : '222 22% 12%'
  )
  const mutedToken = resolveCssVarToken(
    rootStyle,
    '--muted',
    isDark ? '224 18% 18%' : '220 18% 96%'
  )
  const mutedForegroundToken = resolveCssVarToken(
    rootStyle,
    '--muted-foreground',
    isDark ? '215 12% 62%' : '220 8% 44%'
  )
  const accentToken = resolveCssVarToken(
    rootStyle,
    '--accent',
    isDark ? '218 90% 64%' : '218 84% 56%'
  )
  const borderToken = resolveCssVarToken(
    rootStyle,
    '--border',
    isDark ? '224 18% 22%' : '220 12% 90%'
  )
  const tableFontFamilyRaw = rootStyle.getPropertyValue('--table-font-family').trim()
  const tableFontFamily =
    tableFontFamilyRaw || 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  const tableFontSize = parseCssNumber(rootStyle.getPropertyValue('--table-font-size'), 12, {
    min: 10,
    max: 20,
  })
  const fontSizeXS = Math.round(tableFontSize)
  const fontWeight = Math.round(
    parseCssNumber(rootStyle.getPropertyValue('--table-font-weight'), 400, {
      min: 300,
      max: 700,
    })
  )
  const headerFontWeight = Math.round(
    parseCssNumber(rootStyle.getPropertyValue('--table-header-font-weight'), fontWeight + 200, {
      min: 400,
      max: 800,
    })
  )

  return {
    fontFamily: tableFontFamily,
    fontSizeXXS: Math.max(10, fontSizeXS - 2),
    fontSizeXS,
    fontSizeSM: fontSizeXS + 1,
    fontSizeMD: fontSizeXS + 2,
    fontSizeLG: fontSizeXS + 4,
    fontWeight,
    headerFontWeight,
    iconFgCommon: hslToken(mutedForegroundToken, isDark ? 0.95 : 0.9),
    iconFgSelected: hslToken('0 0% 100%', 1),
    iconBgSelected: hslToken(accentToken, isDark ? 0.9 : 0.86),
    cellBg: hslToken(backgroundToken),
    cellBgHovered: hslToken(mutedToken, isDark ? 0.5 : 0.42),
    cellBgSelected: hslToken(accentToken, isDark ? 0.26 : 0.14),
    cellBgLoading: hslToken(accentToken, isDark ? 0.2 : 0.1),
    cellLineColor: hslToken(borderToken, isDark ? 0.9 : 0.82),
    cellLineColorActived: hslToken(foregroundToken, isDark ? 0.78 : 0.66),
    cellTextColor: hslToken(foregroundToken, isDark ? 0.95 : 0.9),
    cellTextColorHighlight: hslToken(accentToken, 1),
    cellOptionBg: hslToken(mutedToken, isDark ? 0.8 : 0.74),
    cellOptionBgHighlight: hslToken(mutedToken, isDark ? 0.95 : 0.88),
    cellOptionTextColor: hslToken(foregroundToken, isDark ? 0.92 : 0.88),
    groupHeaderBgPrimary: hslToken(mutedToken, isDark ? 0.36 : 0.3),
    groupHeaderBgSecondary: hslToken(mutedToken, isDark ? 0.5 : 0.4),
    groupHeaderBgTertiary: hslToken(mutedToken, isDark ? 0.64 : 0.5),
    columnHeaderBg: hslToken(mutedToken, isDark ? 0.48 : 0.38),
    columnHeaderBgHovered: hslToken(mutedToken, isDark ? 0.62 : 0.54),
    columnHeaderBgSelected: hslToken(accentToken, isDark ? 0.3 : 0.2),
    columnHeaderNameColor: hslToken(foregroundToken, isDark ? 0.96 : 0.9),
    columnResizeHandlerBg: hslToken(foregroundToken, isDark ? 0.38 : 0.28),
    columnDraggingPlaceholderBg: hslToken(foregroundToken, isDark ? 0.22 : 0.16),
    columnStatisticBgHovered: hslToken(mutedToken, isDark ? 0.82 : 0.7),
    rowHeaderTextColor: hslToken(mutedForegroundToken, isDark ? 0.98 : 0.9),
    appendRowBg: hslToken(accentToken, isDark ? 0.14 : 0.06),
    appendRowBgHovered: hslToken(accentToken, isDark ? 0.22 : 0.12),
    avatarBg: hslToken(mutedToken, isDark ? 0.72 : 0.58),
    avatarTextColor: hslToken(foregroundToken, isDark ? 0.92 : 0.86),
    themeKey: resolvedTheme,
    scrollBarBg: hslToken(borderToken, isDark ? 0.9 : 0.82),
    interactionLineColorCommon: hslToken(mutedForegroundToken, isDark ? 0.62 : 0.44),
    interactionLineColorHighlight: hslToken(accentToken, 1),
    searchCursorBg: hslToken(accentToken, isDark ? 0.34 : 0.26),
    searchTargetIndexBg: hslToken(accentToken, isDark ? 0.24 : 0.18),
    commentCountBg: hslToken('24 94% 56%'),
    commentCountTextColor: hslToken('0 0% 100%'),
  }
}

// ---------------------------------------------------------------------------
// Column mapping: TableGridColumn → IGridColumn
// ---------------------------------------------------------------------------
function mapColumns(columns: TableGridColumn[], summaryLabel: string): IGridColumn[] {
  return columns.map((col, index) => {
    const fieldType = col.originalFieldType ?? col.type ?? 'text'
    const rawDescription = typeof col.description === 'string' ? col.description.trim() : ''
    const rawName = (col.headerName ?? col.field ?? '').trim()
    const normalizedDescription =
      rawDescription.length > 0 && rawDescription !== rawName
        ? rawDescription
        : undefined

    const icon = FIELD_TYPE_ICON_MAP[fieldType] ?? 'text'

    return {
      id: col.field,
      name: col.headerName ?? col.field,
      width: col.width,
      icon,
      hasMenu: true,
      readonly: col.editable === false,
      isPrimary: col.isPrimaryField,
      description: normalizedDescription,
      statisticLabel: {
        showAlways: index === 0,
        label: summaryLabel,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Build select choices from column's cellEditorParams
// Returns both choiceMap (for canvas rendering) and choiceSorted (for editor dropdown)
// ---------------------------------------------------------------------------
interface SelectChoicesResult {
  choiceMap: Record<string, ISelectChoice> | undefined
  choiceSorted: ISelectChoiceSorted[] | undefined
}

function buildSelectChoices(col: TableGridColumn): SelectChoicesResult {
  const rawChoices = col.cellEditorParams?.choices as any[] | undefined
  const values = col.cellEditorParams?.values as unknown[] | undefined

  if (Array.isArray(rawChoices) && rawChoices.length > 0) {
    const map: Record<string, ISelectChoice> = {}
    const sorted: ISelectChoiceSorted[] = []
    for (const choice of rawChoices) {
      const name = typeof choice === 'string'
        ? choice
        : String(choice.value ?? choice.id ?? choice.name ?? choice.label ?? choice)
      const backendColor = typeof choice === 'object' && choice?.color ? String(choice.color) : undefined
      const { color, backgroundColor } = resolveSelectChipColors({
        value: name,
        label: name,
        color: backendColor,
      })
      map[name] = { id: name, name, color, backgroundColor }
      sorted.push({ id: name, name })
    }
    return { choiceMap: map, choiceSorted: sorted }
  }

  if (!Array.isArray(values) || values.length === 0) {
    return { choiceMap: undefined, choiceSorted: undefined }
  }
  const map: Record<string, ISelectChoice> = {}
  const sorted: ISelectChoiceSorted[] = []
  for (const v of values) {
    const name = typeof v === 'string' ? v : String(v)
    const { color, backgroundColor } = getFallbackChoiceColor(name)
    map[name] = { id: name, name, color, backgroundColor }
    sorted.push({ id: name, name })
  }
  return { choiceMap: map, choiceSorted: sorted }
}

const normalizeDateRawValue = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') {
    return null
  }

  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null
    }
    return value.toISOString()
  }

  return String(value)
}

const resolveDateFieldOptions = (
  col: TableGridColumn,
  _fieldType: string,
): DateFieldOptionsLike | undefined => {
  const options = col.options as DateFieldOptionsLike | undefined
  if (!options || typeof options !== 'object') {
    return undefined
  }
  return options
}

const resolveColumnDisplayValue = (
  col: TableGridColumn | undefined,
  value: unknown,
  row?: TableGridRow,
  emptyLabel = ''
): string => {
  if (value === null || value === undefined || value === '') {
    return emptyLabel
  }

  if (typeof col?.valueFormatter === 'function') {
    try {
      const formatted = col.valueFormatter({ value, data: row })
      if (formatted !== null && formatted !== undefined) {
        return String(formatted)
      }
    } catch {
      // 回退到默认字符串化，避免展示中断
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => stringifyDisplayItem(item)).join(', ')
  }

  if (typeof value === 'object') {
    return stringifyDisplayItem(value)
  }

  return String(value)
}

/**
 * email / url / phone 单元格值统一转纯字符串。
 * 兼容历史脏数据：过去内联编辑曾把值写成 [{id,title}] 对象数组，
 * 直接 String() 会得到 [object Object]，这里做兜底解析取出真实文本。
 * 手动粘贴常带前后空白，统一 trim，避免点击时拼出非法 href。
 */
const coerceContactString = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const first = value.find((item) => item !== null && item !== undefined)
    return first === undefined ? '' : coerceContactString(first)
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const inner = obj.url ?? obj.title ?? obj.value ?? obj.name ?? obj.label ?? obj.id
    return inner === null || inner === undefined ? '' : String(inner).trim()
  }
  return String(value).trim()
}

const CHECKBOX_FALSE_STRINGS = new Set(['false', '0', 'no', 'off', '否', 'unchecked'])

const toSafeBool = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    if (value === '' || CHECKBOX_FALSE_STRINGS.has(value.toLowerCase())) return false
    return true
  }
  return value != null
}

/** 将任意值安全地转为展示字符串，避免 [object Object] */
const stringifyDisplayItem = (item: unknown): string => {
  if (item === null || item === undefined) return ''
  if (typeof item === 'string') return item
  if (typeof item === 'number' || typeof item === 'boolean') return String(item)
  if (typeof item === 'object') {
    const obj = item as Record<string, unknown>
    const label = obj.title ?? obj.name ?? obj.display_name ?? obj.label ?? obj.id
    if (label != null) return String(label)
    try { return JSON.stringify(item) } catch { /* fallback */ }
  }
  return String(item)
}

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const pickFirstString = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value !== 'string') {
      continue
    }
    const trimmed = value.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return undefined
}

const pickFirstNumber = (record: Record<string, unknown>, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

const getFileNameFromUrl = (url: string): string => {
  const path = url.split('?')[0]?.split('#')[0] ?? ''
  const segment = path.split('/').filter(Boolean).pop()
  if (!segment) return ''
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type AttachmentThumbnailFile = {
  fileId: string
  assetFileId?: string
  src: string
  name: string
  mimetype: string
  accessContext?: TableGridAttachmentAccessContext
}

type AttachmentThumbnailUi = {
  resolveThumbnailUrl?: (file: AttachmentThumbnailFile) => Promise<string>
}

const createAttachmentThumbnailResolver = (
  loadPreviewUi: CreateCellContentOptions['loadAttachmentPreviewUi'],
  file: AttachmentThumbnailFile
): (() => Promise<string>) | undefined => {
  if (!loadPreviewUi || !file.assetFileId) {
    return undefined
  }

  return async () => {
    const previewUi = await loadPreviewUi() as AttachmentThumbnailUi
    if (typeof previewUi.resolveThumbnailUrl !== 'function') {
      return file.src
    }
    return previewUi.resolveThumbnailUrl(file)
  }
}

interface CreateCellContentOptions {
  onSelectOptionAdd?: (fieldName: string, optionName: string) => void | Promise<void>
  onAttachmentUpload?: TableGridRendererProps['onAttachmentUpload']
  onAttachmentFileRef?: TableGridRendererProps['onAttachmentFileRef']
  onDownloadAttachment?: TableGridRendererProps['onDownloadAttachment']
  onDownloadAllAttachments?: TableGridRendererProps['onDownloadAllAttachments']
  loadAttachmentPreviewUi?: TableGridRendererProps['loadAttachmentPreviewUi']
  onAttachmentPreview?: (files: AttachmentPreviewFile[], activeId: string) => void
  onLinkCellExpand?: (recordId: string, fieldId: string, column: TableGridColumn) => void
  onLinkTagClick?: (recordId: string, fieldId: string, linkedRecordId: string) => void
  onUrlCellClick?: (url: string) => void
  editorLabels?: TableGridCanvasEditorLabels
  organizationMembers?: OrganizationMemberOption[]
  userDisplayNameById?: ReadonlyMap<string, string>
  /** 当前视图的子记录父链 link 字段 id（屏蔽父记录弹窗 + 标题兜底解析） */
  subRecordParentFieldId?: string | null
  /** 按记录 id 解析主字段标题（父链值只有裸 id 时兜底显示） */
  resolveLinkTitleById?: (recordId: string) => string | undefined
}

// ---------------------------------------------------------------------------
// Cell content factory: (row, column) → ICell
// Comprehensive mapping for ALL field types
// ---------------------------------------------------------------------------
function createCellContent(
  row: TableGridRow | undefined,
  col: TableGridColumn | undefined,
  rowIndex: number,
  colIndex: number,
  options: CreateCellContentOptions = {}
): ICell {
  if (!row || !col) {
    return { type: CellType.Loading } as ICell
  }

  const { onLinkCellExpand, onLinkTagClick, onUrlCellClick } = options
  const field = col.field
  const rawValue = (row as Record<string, unknown>)[field]
  const recordId = resolveRecordId(row) ?? String(rowIndex)
  const cellId = `${recordId}-${col.fieldId ?? field}`
  const isReadonly = col.editable === false
  const fieldType = col.originalFieldType ?? col.type ?? 'text'

  // Format display value via column's valueFormatter if available
  const displayValue = resolveColumnDisplayValue(col, rawValue, row)

  switch (fieldType) {
    // ── Date / Datetime ─────────────────────────────────────────────
    case 'date': {
      const rawDateValue = normalizeDateRawValue(rawValue)
      const dateOptions = resolveDateFieldOptions(col, fieldType)

      return {
        type: CellType.Text,
        id: cellId,
        data: rawDateValue ?? '',
        displayData: displayValue,
        readonly: isReadonly,
        customEditor: (props, editorRef) => (
          <DeferredGridDateEditor
            ref={editorRef}
            value={rawDateValue}
            options={dateOptions}
            {...props}
          />
        ),
      } satisfies ITextCell
    }

    // ── Numeric types ───────────────────────────────────────────────
    case 'number':
    case 'count':
    case 'currency': {
      return {
        type: CellType.Number,
        id: cellId,
        data: rawValue != null ? Number(rawValue) : null,
        displayData: displayValue,
        readonly: isReadonly,
        contentAlign: 'right',
      } satisfies INumberCell
    }

    case 'percent': {
      // Editor works in percent points (12); storage remains ratio (0.12).
      const ratio = rawValue != null && rawValue !== '' ? Number(rawValue) : NaN
      const percentPoints = Number.isFinite(ratio) ? Number((ratio * 100).toFixed(8)) : null
      return {
        type: CellType.Number,
        id: cellId,
        data: percentPoints,
        displayData: displayValue,
        readonly: isReadonly,
        contentAlign: 'right',
      } satisfies INumberCell
    }

    // ── Boolean / Checkbox ──────────────────────────────────────────
    case 'checkbox':
    case 'boolean': {
      return {
        type: CellType.Boolean,
        id: cellId,
        data: toSafeBool(rawValue),
        readonly: isReadonly,
      } satisfies IBooleanCell
    }

    // ── Single Select ───────────────────────────────────────────────
    case 'single_select':
    case 'select': {
      const strVal = rawValue != null
        ? (typeof rawValue === 'object' && rawValue !== null && 'title' in (rawValue as Record<string, unknown>)
          ? String((rawValue as Record<string, unknown>).title)
          : String(rawValue))
        : ''
      const dataArr = strVal ? [strVal] : []
      const displayArr = strVal ? [displayValue || strVal] : []
      const { choiceMap, choiceSorted } = buildSelectChoices(col)
      return {
        type: CellType.Select,
        id: cellId,
        data: dataArr,
        displayData: displayArr,
        choiceMap,
        choiceSorted,
        isMultiple: false,
        isEditingOnClick: true,
        readonly: isReadonly,
        onOptionAdd: options.onSelectOptionAdd
          ? (name: string) => options.onSelectOptionAdd?.(field, name)
          : undefined,
      } satisfies ISelectCell
    }

    // ── Multi Select ────────────────────────────────────────────────
    case 'multi_select': {
      let dataArr: string[] = []
      if (Array.isArray(rawValue)) {
        dataArr = rawValue.map((v: unknown) =>
          typeof v === 'object' && v !== null && 'title' in (v as Record<string, unknown>)
            ? String((v as Record<string, unknown>).title)
            : String(v)
        )
      } else if (typeof rawValue === 'string' && rawValue) {
        // Comma-separated fallback
        dataArr = rawValue.split(',').map((s) => s.trim()).filter(Boolean)
      }
      const displayArr = dataArr.length > 0 ? dataArr : []
      const { choiceMap, choiceSorted } = buildSelectChoices(col)
      return {
        type: CellType.Select,
        id: cellId,
        data: dataArr,
        displayData: displayArr,
        choiceMap,
        choiceSorted,
        isMultiple: true,
        isEditingOnClick: true,
        readonly: isReadonly,
        onOptionAdd: options.onSelectOptionAdd
          ? (name: string) => options.onSelectOptionAdd?.(field, name)
          : undefined,
      } satisfies ISelectCell
    }

    // ── Rating ──────────────────────────────────────────────────────
    case 'rating': {
      const max = (col.cellEditorParams?.max as number) || 5
      return {
        type: CellType.Rating,
        id: cellId,
        data: rawValue != null ? Number(rawValue) : 0,
        icon: 'star',
        color: '#FFB400',
        max,
        readonly: isReadonly,
      } satisfies IRatingCell
    }

    // ── Attachment / Image ──────────────────────────────────────────
    case 'attachment': {
      const images: IImageData[] = []
      const previewFiles: AttachmentPreviewFile[] = []
      const attachments = Array.isArray(rawValue)
        ? rawValue
        : rawValue == null
          ? []
          : [rawValue]
      attachments.forEach((item, index) => {
        if (typeof item === 'string') {
          const url = item.trim()
          if (url) {
            images.push({ id: url, url })
            previewFiles.push({
              fileId: url,
              src: url,
              name: getFileNameFromUrl(url) || `Attachment ${index + 1}`,
              mimetype: '',
            })
          }
          return
        }

        if (!isRecordValue(item)) {
          return
        }

        const uploadStatus = pickFirstString(item, ['upload_status']) as IImageData['uploadStatus']
        const uploadProgress = pickFirstNumber(item, ['upload_progress'])
        const uploading =
          item.__uploading === true ||
          uploadStatus === 'pending' ||
          uploadStatus === 'uploading'
        const url = pickFirstString(item, [
          'url',
          'presignedUrl',
          'access_url',
          'accessUrl',
          'download_url',
          'downloadUrl',
          'path',
        ])
        const explicitFileId = pickFirstString(item, ['file_id', 'fileId', 'asset_file_id', 'assetFileId'])
        const legacyId = pickFirstString(item, ['id'])
        const assetFileId = explicitFileId ?? (
          url?.includes('feishu_import') && legacyId && UUID_PATTERN.test(legacyId)
            ? legacyId
            : undefined
        )
        if (!url && !uploading && !assetFileId) {
          return
        }

        const id =
          pickFirstString(item, ['upload_item_id', 'reference_id', 'id', 'file_id', 'token']) ??
          `${cellId}-attachment-${index}`
        const name = pickFirstString(item, ['name', 'file_name', 'fileName', 'title'])
        const mimeType = pickFirstString(item, [
          'mimeType', 'mime_type', 'mimetype', 'content_type', 'contentType',
        ])
        const resolvedName = name ?? `Attachment ${index + 1}`
        const accessContext = {
          referenceId: pickFirstString(item, ['reference_id', 'referenceId']),
          fieldId: col.fieldId,
          recordId: resolveRecordId(row) ?? undefined,
        }
        images.push({
          id,
          url: url ?? '',
          name,
          mimeType,
          resolveUrl: createAttachmentThumbnailResolver(options.loadAttachmentPreviewUi, {
            fileId: id,
            assetFileId,
            src: url ?? '',
            name: resolvedName,
            mimetype: mimeType ?? '',
            accessContext,
          }),
          uploading,
          uploadStatus,
          uploadProgress:
            typeof uploadProgress === 'number'
              ? Math.min(1, Math.max(0, uploadProgress))
              : undefined,
          ...(item.__local_upload_overlay === true ? { localUploadOverlay: true } : {}),
        })
        if (url || assetFileId) {
          previewFiles.push({
            fileId: id,
            src: url ?? '',
            name: resolvedName,
            mimetype: mimeType ?? '',
            thumb: url ?? '',
            downloadUrl: url ?? '',
            assetFileId,
            accessContext,
          })
        }
      })
      return {
        type: CellType.Image,
        id: cellId,
        data: images,
        displayData: images.map((img) => img.url),
        readonly: isReadonly,
        editorWidth: 462,
        onPreview: options.onAttachmentPreview
          ? (activeId) => options.onAttachmentPreview?.(previewFiles, activeId)
          : undefined,
        customEditor: (props, editorRef) => (
          <DeferredGridAttachmentEditor
            ref={editorRef}
            rowData={row}
            field={field}
            fieldId={col.fieldId}
            rawValue={rawValue}
            onAttachmentUpload={options.onAttachmentUpload}
            onAttachmentFileRef={options.onAttachmentFileRef}
            onDownloadAttachment={options.onDownloadAttachment}
            onDownloadAllAttachments={options.onDownloadAllAttachments}
            loadPreviewUi={
              options.loadAttachmentPreviewUi as
                | (() => Promise<{
                    Dialog: React.ComponentType<any>
                    Provider: React.ComponentType<{ children?: React.ReactNode }>
                  }>)
                | undefined
            }
            labels={options.editorLabels}
            {...props}
          />
        ),
      } satisfies IImageCell
    }

    // ── URL / Email → Link (可点击) ───────────────────────────────────
    case 'url':
    case 'email': {
      const strVal = coerceContactString(rawValue)
      return {
        type: CellType.Link,
        id: cellId,
        data: strVal ? [{ id: strVal, title: strVal }] : [],
        displayData: displayValue || strVal,
        readonly: isReadonly,
        onClick: strVal
          ? (v: string) => {
              if (fieldType === 'url') {
                const href = normalizeUrlCellHref(v)
                if (!href) return
                // ：宿主接入时在当前 Space 内置浏览器（tabweb）打开；
                // 未接入（如 Web 端或单测）回退默认 <a target=_blank> 外链行为。
                if (onUrlCellClick) {
                  onUrlCellClick(href)
                  return
                }
                const a = document.createElement('a')
                a.href = href
                a.rel = 'noopener noreferrer'
                a.target = '_blank'
                a.click()
              } else {
                const a = document.createElement('a')
                a.href = `mailto:${v.trim()}`
                a.rel = 'noopener noreferrer'
                a.click()
              }
            }
          : undefined,
      } satisfies ILinkCell
    }

    // ── Phone → Link (可点击，tel:) ────────────────────────────────────
    case 'phone': {
      const phoneStr = coerceContactString(rawValue)
      return {
        type: CellType.Link,
        id: cellId,
        data: phoneStr ? [{ id: phoneStr, title: phoneStr }] : [],
        displayData: displayValue || phoneStr,
        readonly: isReadonly,
        onClick: phoneStr
          ? (v: string) => {
              const a = document.createElement('a')
              a.href = `tel:${v}`
              a.click()
            }
          : undefined,
      } satisfies ILinkCell
    }

    // ── User / Created By / Last Modified By ────────────────────────
    // created_by / last_modified_by 是系统计算字段，强制只读
    // user 字段在没有 customEditor 时也强制只读（无内置 User 编辑器）
    case 'user':
    case 'created_by':
    case 'last_modified_by': {
      const memberMap = new Map(
        (options.organizationMembers ?? []).map((m) => [m.id, m] as const),
      )
      const users: IUserData[] = []
      const items = Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : []
      for (const item of items) {
        if (typeof item === 'string') {
          // 写入值可能是纯 user id：先查在职成员目录，再退到离组快照，都不认识就说「未知」。
          const member = memberMap.get(item)
          const resolution = resolveUserDisplay(item, {
            currentMemberName: member?.name,
            resolvedNameById: options.userDisplayNameById,
            isCurrentMember: memberMap.has(item),
          })
          users.push({
            id: item,
            name: userDisplayLabel(resolution),
            avatarUrl: resolution.canUseDirectoryAvatar ? member?.avatarUrl : undefined,
          })
        } else if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>
          const id = String(obj.id ?? obj.user_id ?? '')
          const member = memberMap.get(id)
          const resolution = resolveUserDisplay(id, {
            embeddedName: obj.name ?? obj.display_name ?? obj.email,
            currentMemberName: member?.name,
            resolvedNameById: options.userDisplayNameById,
            isCurrentMember: memberMap.has(id),
          })
          users.push({
            id,
            name: userDisplayLabel(resolution),
            avatarUrl: (obj.avatar_url ?? obj.avatarUrl ?? undefined) as string | undefined,
          })
        }
      }
      // created_by / last_modified_by 是系统计算字段，强制只读；
      // user 字段挂内联编辑器（复用记录表单 UserSelector）。
      const isSystemUserField = fieldType === 'created_by' || fieldType === 'last_modified_by'
      const userEditable = !isSystemUserField && !isReadonly && (options.organizationMembers?.length ?? 0) > 0
      const isMultipleUser = (col.options as Record<string, unknown> | undefined)?.multiple === true
      const initialUserValue: string | string[] | null = isMultipleUser
        ? (users.length > 0 ? users.map((u) => u.id) : null)
        : (users[0]?.id ?? null)
      return {
        type: CellType.User,
        id: cellId,
        data: users,
        displayData: users.map((u) => u.name).join(', '),
        readonly: !userEditable,
        customEditor: userEditable
          ? (props, editorRef) => (
              <DeferredGridUserEditor
                ref={editorRef}
                users={options.organizationMembers ?? []}
                multiple={isMultipleUser}
                initialValue={initialUserValue}
                {...props}
              />
            )
          : undefined,
      } satisfies IUserCell
    }

    // ── Link (关联字段) → render as tag pills ─────────────────────
    // 对齐 teable：Link 字段通过 onExpand 弹窗编辑关联关系，
    // TextEditor 无法处理 ILinkCellValue[] 数据格式，故强制 readonly
    case 'link': {
      const linkValues: ILinkCellValue[] = []
      if (Array.isArray(rawValue)) {
        for (const v of rawValue) {
          if (v && typeof v === 'object') {
            const obj = v as Record<string, unknown>
            linkValues.push({
              id: String(obj.id ?? ''),
              title: String(obj.title ?? obj.name ?? obj.id ?? ''),
            })
          } else if (typeof v === 'string') {
            linkValues.push({ id: v, title: v })
          }
        }
      } else if (rawValue && typeof rawValue === 'object') {
        const obj = rawValue as Record<string, unknown>
        linkValues.push({
          id: String(obj.id ?? ''),
          title: String(obj.title ?? obj.name ?? obj.id ?? ''),
        })
      }
      const linkFieldId = col.fieldId ?? col.field
      // 子记录父链字段：① link title 是后端保存时的非权威投影，优先按已加载的
      // 父记录当前主字段解析标题；② 屏蔽点击弹窗——
      // 「编辑关联记录」弹窗本身属已隐藏的问题功能，父链字段不挂 onClick/onExpand。
      const isSubRecordParentLinkField =
        !!options.subRecordParentFieldId && linkFieldId === options.subRecordParentFieldId
      if (isSubRecordParentLinkField) {
        for (const lv of linkValues) {
          lv.title = resolveSubRecordParentLinkTitle(
            lv.id,
            lv.title,
            options.resolveLinkTitleById,
          )
        }
      }
      for (const linkValue of linkValues) {
        linkValue.title = resolveLinkRecordDisplayTitle(linkValue.id, linkValue.title)
      }
      return {
        type: CellType.Link,
        id: cellId,
        data: linkValues,
        displayData: linkValues.map((v) => v.title).join(', '),
        readonly: true,
        onClick: isSubRecordParentLinkField
          ? undefined
          : (linkedRecordId: string) => onLinkTagClick?.(recordId, linkFieldId, linkedRecordId),
        onExpand: isSubRecordParentLinkField
          ? undefined
          : () => onLinkCellExpand?.(recordId, linkFieldId, col),
      } satisfies ILinkCell
    }

    // ── Lookup: type-aware read-only rendering ────────────────────
    // ── Created Time / Last Modified Time (系统时间，优先使用 displayValue) ──
    case 'created_time':
    case 'last_modified_time': {
      let displayText = displayValue || ''
      if (!displayText && rawValue) {
        try {
          const d = new Date(String(rawValue))
          if (!isNaN(d.getTime())) {
            displayText = d.toLocaleString()
          } else {
            displayText = String(rawValue)
          }
        } catch {
          displayText = String(rawValue)
        }
      }
      return {
        type: CellType.Text,
        id: cellId,
        data: displayText,
        displayData: displayText,
        readonly: true,
      } satisfies ITextCell
    }

    // ── Long Text (多行文本，使用 textarea 编辑器) ────────────────────
    case 'long_text': {
      const textData = rawValue != null ? String(rawValue) : ''
      return {
        type: CellType.Text,
        id: cellId,
        data: textData,
        displayData: displayValue,
        isWrap: true,
        readonly: isReadonly,
        customEditor: (props, editorRef) => (
          <GridLongTextEditor
            ref={editorRef}
            value={textData}
            {...props}
          />
        ),
      } satisfies ITextCell
    }

    // ── Default: render as text ─────────────────────────────────────
    // Covers: text and fallback for
    // computed/system fields (created_by, last_modified_by)
    default: {
      const isComputedOrSystem =
        fieldType === 'created_by' ||
        fieldType === 'last_modified_by'
      return {
        type: CellType.Text,
        id: cellId,
        data: displayValue,
        displayData: displayValue,
        isWrap: true,
        readonly: isComputedOrSystem || isReadonly,
      } satisfies ITextCell
    }
  }
}

// ---------------------------------------------------------------------------
// Clipboard helpers
// ---------------------------------------------------------------------------

function clipboardFormatCellValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map(v => {
        if (v == null) return ''
        if (typeof v === 'object') {
          const o = v as Record<string, unknown>
          return String(o.title ?? o.name ?? o.id ?? JSON.stringify(v))
        }
        return String(v)
      })
      .join(', ')
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    return String(o.title ?? o.name ?? o.id ?? JSON.stringify(value))
  }
  return String(value)
}

function clipboardEscapeTsv(value: string): string {
  if (value.includes('\t') || value.includes('\n') || value.includes('\r') || value.includes('"')) {
    return '"' + value.replace(/"/g, '""') + '"'
  }
  return value
}

// ---------------------------------------------------------------------------
// Group extraction: convert TabTin's flat row array (with __rowType markers)
// into Teable's { dataRows, groupPoints, collapsedGroupIds } structure
// ---------------------------------------------------------------------------
interface GroupFieldMeta {
  /** Field name used in the row data (key of __groupValues) */
  fieldName: string
  /** Group depth (0, 1, 2) */
  depth: number
}

interface GroupedDataResult {
  dataRows: TableGridRow[]
  groupPoints: IGroupPoint[] | null
  collapsedGroupIds: Set<string> | null
  prefillingRowIndexes: number[]
  /** Group field metadata extracted from group_header rows, ordered by depth */
  groupFieldMetas: GroupFieldMeta[]
}

function extractGroupedData(rows: TableGridRow[]): GroupedDataResult {
  // Quick check: if no rows have __rowType, skip group processing entirely
  const hasSpecialRows = rows.some(
    (r) => typeof (r as Record<string, unknown>).__rowType === 'string'
  )

  if (!hasSpecialRows) {
    return {
      dataRows: rows,
      groupPoints: null,
      collapsedGroupIds: null,
      prefillingRowIndexes: [],
      groupFieldMetas: [],
    }
  }

  const dataRows: TableGridRow[] = []
  const groupPoints: IGroupPoint[] = []
  const collapsedGroupIds = new Set<string>()
  const prefillingRowIndexes: number[] = []
  // Track group field names by depth, extracted from __groupValues keys
  const groupFieldByDepth = new Map<number, string>()
  let consecutiveDataCount = 0

  const flushDataRows = () => {
    if (consecutiveDataCount > 0) {
      groupPoints.push({ type: LinearRowType.Row, count: consecutiveDataCount })
      consecutiveDataCount = 0
    }
  }

  for (const row of rows) {
    const r = row as Record<string, unknown>
    const rowType = r.__rowType as string | undefined

    if (!rowType) {
      // Pure data row
      dataRows.push(row)
      consecutiveDataCount++
      continue
    }

    if (rowType === 'draft') {
      // Draft row treated as data row
      prefillingRowIndexes.push(dataRows.length)
      dataRows.push(row)
      consecutiveDataCount++
      continue
    }

    if (rowType === 'group_header') {
      flushDataRows()
      const groupPath = (r.__groupPath as string) || `group_${groupPoints.length}`
      const depth = typeof r.__groupLevel === 'number' ? r.__groupLevel : 0
      const isCollapsed = Boolean(r.__groupCollapsed)
      const groupValue = r.__groupDisplayValue ?? r.__groupValue ?? r.__groupLabel ?? groupPath

      groupPoints.push({
        id: groupPath,
        type: LinearRowType.Group,
        depth,
        value: groupValue,
        isCollapsed,
      })

      if (isCollapsed) {
        collapsedGroupIds.add(groupPath)
      }

      // Extract group field name for this depth from __groupValues
      if (!groupFieldByDepth.has(depth)) {
        const groupValues = r.__groupValues as Record<string, unknown> | undefined
        if (groupValues && typeof groupValues === 'object') {
          const keys = Object.keys(groupValues)
          // The key at position [depth] is the field name for this depth level
          if (keys[depth]) {
            groupFieldByDepth.set(depth, keys[depth])
          }
        }
      }

      continue
    }

    if (rowType === 'group_add') {
      flushDataRows()
      groupPoints.push({
        type: LinearRowType.Append,
        groupPath:
          typeof r.__groupPath === 'string' && r.__groupPath.length > 0
            ? r.__groupPath
            : undefined,
        groupValues:
          r.__groupValues && typeof r.__groupValues === 'object'
            ? (r.__groupValues as Record<string, unknown>)
            : undefined,
      })
      continue
    }

    if (rowType === 'add') {
      flushDataRows()
      groupPoints.push({ type: LinearRowType.Append })
      continue
    }

    // Unknown row type — skip it
  }

  // Flush any trailing data rows
  flushDataRows()

  // Build ordered group field metas
  const groupFieldMetas: GroupFieldMeta[] = []
  const sortedDepths = Array.from(groupFieldByDepth.keys()).sort((a, b) => a - b)
  for (const depth of sortedDepths) {
    const fieldName = groupFieldByDepth.get(depth)
    if (fieldName) {
      groupFieldMetas.push({ fieldName, depth })
    }
  }

  const result = {
    dataRows,
    groupPoints: groupPoints.length > 0 ? groupPoints : null,
    collapsedGroupIds: collapsedGroupIds.size > 0 ? collapsedGroupIds : null,
    prefillingRowIndexes,
    groupFieldMetas,
  }
  return result
}

// ---------------------------------------------------------------------------
// Row control mapping
// ---------------------------------------------------------------------------
function mapRowControls(
  controls?: Array<{ type: string; icon?: string }>
): IRowControlItem[] {
  if (!controls?.length) {
    return [{ type: RowControlType.Checkbox }]
  }
  return controls.map((c) => ({
    type:
      c.type === 'checkbox'
        ? RowControlType.Checkbox
        : c.type === 'expand'
          ? RowControlType.Expand
          : RowControlType.Drag,
    icon: c.icon,
  }))
}

function resolveGridDraggableType(
  onRowMoved?: TableGridRendererProps['onRowMoved'],
  onColumnMoved?: TableGridRendererProps['onColumnMoved'],
): DraggableType {
  const canDragRow = onRowMoved != null
  const canDragColumn = onColumnMoved != null
  if (!canDragRow && !canDragColumn) return DraggableType.None
  if (canDragRow && canDragColumn) return DraggableType.All
  if (canDragRow) return DraggableType.Row
  return DraggableType.Column
}

/**
 * Format a statistic value for display in the statistics bar.
 * Follows Teable's pattern: "函数名 值" (e.g. "求和 1234.56")
 */
function formatStatisticDisplay(
  value: string | number | null | undefined,
  labels: Record<string, string>,
  func?: string,
  label?: string
): string {
  const displayValue = value != null ? String(value) : ''

  // If a custom label is provided, use it directly
  if (label) return label

  // If a function name is specified, prefix it (Teable pattern)
  if (func) {
    const funcName = labels[func] ?? func
    if (funcName && displayValue) return `${funcName} ${displayValue}`
    if (funcName) return funcName
  }

  return displayValue
}

// ---------------------------------------------------------------------------
// Column statistics mapping
// ---------------------------------------------------------------------------
function mapColumnStatistics(
  stats: TableGridRendererProps['columnStatistics'] | undefined,
  columns: TableGridColumn[],
  statisticLabels: Record<string, string>
): IColumnStatistics | undefined {
  if (!stats) return undefined
  const result: IColumnStatistics = {}
  for (const col of columns) {
    const stat = stats[col.field]
    if (stat == null) continue
    if (typeof stat === 'object' && stat !== null && 'value' in stat) {
      const mappedStat: IColumnStatistic = {
        total: formatStatisticDisplay(stat.value, statisticLabels, stat.func, stat.label),
      }
      if (stat.groupValues && typeof stat.groupValues === 'object') {
        const groups: Record<string, string> = Object.create(null)
        Object.entries(stat.groupValues).forEach(([groupId, groupValue]) => {
          groups[groupId] = formatStatisticDisplay(groupValue, statisticLabels, stat.func)
        })
        mappedStat.groups = groups
      }
      result[col.field] = mappedStat
    } else {
      result[col.field] = { total: String(stat) }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Freeze column count from config
// ---------------------------------------------------------------------------
function getFreezeColumnCount(config?: TableGridRendererProps['config']): number {
  const fields = config?.freeze?.state?.leftColumnFields
  return fields?.length ?? 1
}

function normalizeSortDirection(direction: unknown): 'asc' | 'desc' | null {
  if (typeof direction !== 'string') {
    return null
  }
  const normalized = direction.toLowerCase()
  if (normalized === 'asc' || normalized === 'desc') {
    return normalized
  }
  return null
}

function normalizeSortModel(sorting: unknown): TableGridSortModelItem[] {
  if (!Array.isArray(sorting)) {
    return []
  }

  const normalized: TableGridSortModelItem[] = []
  const usedFields = new Set<string>()
  sorting.forEach((item) => {
    if (!item || typeof item !== 'object') {
      return
    }
    const rawField = (item as Record<string, unknown>).field
    if (typeof rawField !== 'string') {
      return
    }
    const field = rawField.trim()
    if (!field || usedFields.has(field)) {
      return
    }
    const direction = normalizeSortDirection((item as Record<string, unknown>).direction)
    if (!direction) {
      return
    }
    usedFields.add(field)
    normalized.push({ field, direction })
  })

  return normalized
}

type FillDirection = 'down' | 'up'

const isFillEmptyValue = (value: unknown): boolean =>
  value == null || (Array.isArray(value) && value.length === 0) || (typeof value === 'string' && value.trim() === '')

const isNumberValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isParsableDateValue = (value: unknown): value is string | number | Date =>
  (typeof value === 'string' || typeof value === 'number' || value instanceof Date) &&
  !Number.isNaN(new Date(value as never).getTime())

const toSameDateType = (base: unknown, timestamp: number): unknown => {
  if (typeof base === 'number') return timestamp
  if (base instanceof Date) return new Date(timestamp)
  return new Date(timestamp).toISOString()
}

const shouldGenerateNumberSeries = (values: unknown[]): boolean => {
  const numbers = values.filter(isNumberValue)
  if (numbers.length < 2) return false
  if (values.some((value) => isFillEmptyValue(value))) return false
  const first = numbers[0]
  return numbers.some((value) => value !== first)
}

const shouldGenerateDateSeries = (values: unknown[]): boolean => {
  if (values.length !== 2) return false
  const [left, right] = values
  const leftTime = isParsableDateValue(left) ? new Date(left as never).getTime() : Number.NaN
  const rightTime = isParsableDateValue(right) ? new Date(right as never).getTime() : Number.NaN
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime
}

const generateNumberSeries = (
  baseValues: unknown[],
  outLen: number,
  direction: FillDirection
): unknown[] | null => {
  const numbers = baseValues.filter(isNumberValue)
  if (numbers.length < 2) return null

  const diffs: number[] = []
  for (let index = 1; index < numbers.length; index += 1) {
    diffs.push(numbers[index] - numbers[index - 1])
  }
  if (!diffs.some((diff) => diff !== 0)) return null

  if (direction === 'down') {
    const result: number[] = []
    let current = numbers[numbers.length - 1]
    for (let index = 0; index < outLen; index += 1) {
      const diff = diffs[index % diffs.length]
      current += diff
      result.push(current)
    }
    return result
  }

  const upwardResult: number[] = []
  let current = numbers[0]
  for (let index = 0; index < outLen; index += 1) {
    const diff = diffs[(diffs.length - 1 - (index % diffs.length) + diffs.length) % diffs.length]
    current -= diff
    upwardResult.push(current)
  }
  return upwardResult
}

const generateDateSeries = (
  baseValues: unknown[],
  outLen: number,
  direction: FillDirection
): unknown[] | null => {
  const dates = baseValues.filter(isParsableDateValue)
  if (dates.length < 2) return null

  const latestTimestamp = new Date(dates[dates.length - 1] as never).getTime()
  const previousTimestamp = new Date(dates[dates.length - 2] as never).getTime()
  const stepMilliseconds = latestTimestamp - previousTimestamp || 24 * 60 * 60 * 1000
  const latestRawValue = dates[dates.length - 1]

  if (direction === 'down') {
    const startTimestamp = latestTimestamp + stepMilliseconds
    return Array.from({ length: outLen }, (_, index) =>
      toSameDateType(latestRawValue, startTimestamp + stepMilliseconds * index)
    )
  }

  const firstRawValue = dates[0]
  const firstTimestamp = new Date(firstRawValue as never).getTime()
  const startTimestamp = firstTimestamp - stepMilliseconds
  return Array.from({ length: outLen }, (_, index) =>
    toSameDateType(firstRawValue, startTimestamp - stepMilliseconds * index)
  )
}

const resolveFillFieldType = (column: TableGridColumn | undefined): string =>
  String(column?.originalFieldType ?? column?.type ?? 'text').toLowerCase()

const NUMERIC_FILL_TYPES = new Set([
  'number', 'count', 'percent', 'currency',
])
const DATE_FILL_TYPES = new Set([
  'date', 'created_time', 'last_modified_time',
])

const generateSeriesForColumn = (
  baseColumnValues: unknown[],
  fieldType: string,
  outLen: number,
  direction: FillDirection
): unknown[] => {
  if (outLen <= 0) return []

  if (NUMERIC_FILL_TYPES.has(fieldType) && shouldGenerateNumberSeries(baseColumnValues)) {
    const numberSeries = generateNumberSeries(baseColumnValues, outLen, direction)
    if (numberSeries) return numberSeries
  } else if (DATE_FILL_TYPES.has(fieldType) && shouldGenerateDateSeries(baseColumnValues)) {
    const dateSeries = generateDateSeries(baseColumnValues, outLen, direction)
    if (dateSeries) return dateSeries
  }

  if (baseColumnValues.length === 0) {
    return Array.from({ length: outLen }, () => null)
  }

  if (direction === 'down') {
    return Array.from({ length: outLen }, (_, index) => baseColumnValues[index % baseColumnValues.length])
  }

  return Array.from({ length: outLen }, (_, index) => {
    const length = baseColumnValues.length
    const valueIndex = (length - 1 - ((outLen - 1 - index) % length) + length) % length
    return baseColumnValues[valueIndex]
  })
}

// ---------------------------------------------------------------------------
// Main adapter component
// ---------------------------------------------------------------------------
export type CanvasGridAdapterProps = TableGridRendererProps & {
  onLinkCellExpand?: (recordId: string, fieldId: string, column: TableGridColumn) => void
}

export const CanvasGridAdapter = forwardRef<IGridRef, CanvasGridAdapterProps>(
  function CanvasGridAdapter(props, ref) {
    const {
      columns,
      rows,
      rowControls,
      rowIndexVisible = true,
      commentCountMap,
      columnStatistics,
      config,
      style,
      theme: externalTheme,
      isLoading,
      onGridReady,
      onSortChanged,
      onSelectionChanged,
      onSelectionStateChange,
      onCellValueChanged,
      onCellEditingStopped,
      onAttachmentUpload,
      onAttachmentFileRef,
      onDownloadAttachment,
      onDownloadAllAttachments,
      loadAttachmentPreviewUi,
      onSelectOptionAdd,
      onRowExpand,
      onCommentCountClick,
      onRecordComment,
      onRowAppend,
      onColumnAppend,
      onColumnHeaderContextMenu,
      onColumnStatisticClick,
      onRowContextMenu,
      onInsertSubRecord,
      onDeleteRecords,
      onDuplicateRecord,
      onInsertRecord,
      onCopyRecordUrl,
      onTreeToggle: onTreeToggleProp,
      onRowMoved,
      onColumnMoved,
      onColumnResized,
      onClipboardCopy,
      onClipboardPaste,
      onFreezeStateChange,
      onLinkCellExpand,
      onLinkTagClick,
      onUrlCellClick,
      onTableApiReady,
      onVisibleRegionChanged,
      organizationMembers,
      userDisplayNameById,
      subRecordParentFieldId,
    } = props

    const gridRef = useRef<IGridRef>(null)
    const gridContainerRef = useRef<HTMLElement | null>(null)
    const attachmentPreviewDialogRef = useRef<AttachmentPreviewDialogRef | null>(null)
    const attachmentPreviewLoaderRef = useRef(loadAttachmentPreviewUi)
    const attachmentPreviewUiPromiseRef = useRef<Promise<AttachmentPreviewUi> | null>(null)
    const [attachmentPreviewUi, setAttachmentPreviewUi] = useState<AttachmentPreviewUi | null>(null)
    const [attachmentPreviewFiles, setAttachmentPreviewFiles] = useState<AttachmentPreviewFile[]>([])
    const [pendingAttachmentPreviewId, setPendingAttachmentPreviewId] = useState<string | null>(null)
    const [cssThemeVersion, setCssThemeVersion] = useState(0)
    const normalizedConfigSorting = useMemo(
      () => normalizeSortModel(config?.sorting),
      [config?.sorting]
    )
    const sortModelRef = useRef<TableGridSortModelItem[]>(normalizedConfigSorting)

    useEffect(() => {
      sortModelRef.current = normalizedConfigSorting
    }, [normalizedConfigSorting])

    const ensureAttachmentPreviewUiLoaded = useCallback(async () => {
      if (!loadAttachmentPreviewUi) return null
      if (attachmentPreviewLoaderRef.current !== loadAttachmentPreviewUi) {
        attachmentPreviewLoaderRef.current = loadAttachmentPreviewUi
        attachmentPreviewUiPromiseRef.current = null
        setAttachmentPreviewUi(null)
      }
      if (attachmentPreviewUi && attachmentPreviewLoaderRef.current === loadAttachmentPreviewUi) {
        return attachmentPreviewUi
      }
      if (!attachmentPreviewUiPromiseRef.current) {
        const loader = loadAttachmentPreviewUi
        const loadPromise = loader()
          .then((ui) => {
            const nextUi = ui as AttachmentPreviewUi
            if (attachmentPreviewLoaderRef.current === loader) {
              setAttachmentPreviewUi(nextUi)
            }
            return nextUi
          })
          .catch((error) => {
            if (attachmentPreviewUiPromiseRef.current === loadPromise) {
              attachmentPreviewUiPromiseRef.current = null
            }
            throw error
          })
        attachmentPreviewUiPromiseRef.current = loadPromise
      }
      return attachmentPreviewUiPromiseRef.current
    }, [attachmentPreviewUi, loadAttachmentPreviewUi])

    const handleAttachmentPreview = useCallback(
      (files: AttachmentPreviewFile[], activeId: string) => {
        if (!loadAttachmentPreviewUi || files.length === 0) return
        setAttachmentPreviewFiles(files)
        setPendingAttachmentPreviewId(activeId)
        void ensureAttachmentPreviewUiLoaded().catch(() => {
          setPendingAttachmentPreviewId(null)
        })
      },
      [ensureAttachmentPreviewUiLoaded, loadAttachmentPreviewUi],
    )

    useEffect(() => {
      if (!pendingAttachmentPreviewId || !attachmentPreviewDialogRef.current) return
      attachmentPreviewDialogRef.current.openPreview(pendingAttachmentPreviewId)
      setPendingAttachmentPreviewId(null)
    }, [attachmentPreviewFiles, attachmentPreviewUi, pendingAttachmentPreviewId])

    // Expose ref
    React.useImperativeHandle(ref, () => gridRef.current!, [])

    // Keep canvas theme synced with root css variables (theme / color scheme / table font).
    const themeObserverRef = useRef<MutationObserver | null>(null)
    useEffect(() => {
      if (typeof window === 'undefined' || typeof document === 'undefined') return

      // 先断开已有 observer，防止 StrictMode/HMR 导致多实例并存
      themeObserverRef.current?.disconnect()

      const root = document.documentElement
      let rafId: number | null = null
      const scheduleThemeRefresh = () => {
        if (rafId != null) {
          window.cancelAnimationFrame(rafId)
        }
        rafId = window.requestAnimationFrame(() => {
          setCssThemeVersion((v) => v + 1)
        })
      }

      const observer = new MutationObserver((records) => {
        const shouldRefresh = records.some(
          (record) =>
            record.type === 'attributes' &&
            (record.attributeName === 'class' ||
              record.attributeName === 'style' ||
              record.attributeName === 'data-color-scheme')
        )
        if (shouldRefresh) {
          scheduleThemeRefresh()
        }
      })
      themeObserverRef.current = observer

      observer.observe(root, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-color-scheme'],
      })

      const mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)')
      const handleMediaChange = () => scheduleThemeRefresh()
      mediaQuery?.addEventListener?.('change', handleMediaChange)

      return () => {
        observer.disconnect()
        themeObserverRef.current = null
        mediaQuery?.removeEventListener?.('change', handleMediaChange)
        if (rafId != null) {
          window.cancelAnimationFrame(rafId)
        }
      }
    }, [])

    // Overlay store
    const {
      openHeaderMenu,
      closeHeaderMenu,
      openRecordMenu,
      openStatisticMenu,
      openDescriptionTooltip,
      closeDescriptionTooltip,
    } = useGridOverlayStore()
    const overlayOwnerIdRef = useRef<string>('')
    if (!overlayOwnerIdRef.current) {
      overlayOwnerIdSequence += 1
      overlayOwnerIdRef.current = `canvas-grid-${overlayOwnerIdSequence}`
    }
    const overlayOwnerId = overlayOwnerIdRef.current

    useEffect(() => {
      return () => {
        const overlayStore = useGridOverlayStore.getState()
        if (overlayStore.headerMenu?.ownerId === overlayOwnerId) {
          overlayStore.closeHeaderMenu()
        }
        if (overlayStore.statisticMenu?.ownerId === overlayOwnerId) {
          overlayStore.closeStatisticMenu()
        }
      }
    }, [overlayOwnerId])

    // 记录「本次鼠标交互开始时」哪一列的列头菜单已打开。用 capture 阶段抢在
    // FieldMenu 的 useClickAway（document mousedown 冒泡）关闭菜单之前取值，
    // 让列头点击能据此 toggle：再次点击同一列已打开的菜单 → 关闭而非重开。
    const openHeaderFieldAtMouseDownRef = useRef<string | null>(null)
    useEffect(() => {
      const recordOpenHeaderField = () => {
        const headerMenu = useGridOverlayStore.getState().headerMenu
        openHeaderFieldAtMouseDownRef.current =
          headerMenu?.ownerId === overlayOwnerId ? headerMenu.fields?.[0] ?? null : null
      }
      document.addEventListener('mousedown', recordOpenHeaderField, true)
      return () => document.removeEventListener('mousedown', recordOpenHeaderField, true)
    }, [overlayOwnerId])
    const canvasOverlay = config?.canvasOverlay as TableGridCanvasOverlayConfig | undefined
    const prefillingOverlay = canvasOverlay?.prefilling
    const editorShiftEnterHint = useMemo<string | undefined>(() => {
      const hint = canvasOverlay?.editorShiftEnterHint
      if (typeof hint !== 'string') {
        return undefined
      }
      const trimmed = hint.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }, [canvasOverlay?.editorShiftEnterHint])
    const editorLabels = useMemo<TableGridCanvasEditorLabels | undefined>(
      () => canvasOverlay?.editorLabels,
      [canvasOverlay?.editorLabels]
    )
    const editorSelectSearchPlaceholder = useMemo<string | undefined>(() => {
      const value = editorLabels?.selectSearchPlaceholder
      if (typeof value !== 'string') {
        return undefined
      }
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }, [editorLabels?.selectSearchPlaceholder])
    const editorSelectSearchPlaceholderEmpty = useMemo<string | undefined>(() => {
      const value = editorLabels?.selectSearchPlaceholderEmpty
      if (typeof value !== 'string') {
        return undefined
      }
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }, [editorLabels?.selectSearchPlaceholderEmpty])
    const editorSelectNoResults = useMemo<string | undefined>(() => {
      const value = editorLabels?.selectNoResults
      if (typeof value !== 'string') {
        return undefined
      }
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }, [editorLabels?.selectNoResults])
    const editorSelectEmptyHint = useMemo<string | undefined>(() => {
      const value = editorLabels?.selectEmptyHint
      if (typeof value !== 'string') {
        return undefined
      }
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }, [editorLabels?.selectEmptyHint])
    const editorSelectAddOption = useMemo<string | undefined>(() => {
      const value = editorLabels?.selectAddOption
      if (typeof value !== 'string') {
        return undefined
      }
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }, [editorLabels?.selectAddOption])
    const editorSelectDoneLabel = useMemo<string | undefined>(() => {
      const value = editorLabels?.selectDoneLabel
      if (typeof value !== 'string') {
        return undefined
      }
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }, [editorLabels?.selectDoneLabel])
    const fieldMenuLabels = useMemo<TableGridCanvasFieldMenuLabels | undefined>(
      () => canvasOverlay?.fieldMenuLabels,
      [canvasOverlay?.fieldMenuLabels]
    )
    const recordMenuLabels = useMemo<TableGridCanvasRecordMenuLabels | undefined>(
      () => canvasOverlay?.recordMenuLabels,
      [canvasOverlay?.recordMenuLabels]
    )
    const statisticMenuLabels = useMemo<TableGridCanvasStatisticMenuLabels | undefined>(
      () => canvasOverlay?.statisticMenuLabels,
      [canvasOverlay?.statisticMenuLabels]
    )
    const resolvedStatisticLabels = useMemo<Record<string, string>>(() => {
      const merged: Record<string, string> = { ...defaultStatLabels }
      if (!statisticMenuLabels) {
        return merged
      }
      for (const [key, value] of Object.entries(statisticMenuLabels)) {
        if (typeof value !== 'string') continue
        const trimmed = value.trim()
        if (!trimmed.length) continue
        merged[key] = trimmed
      }
      return merged
    }, [statisticMenuLabels])
    const summaryLabel = useMemo(() => {
      const label = canvasOverlay?.statisticSummaryLabel
      if (typeof label !== 'string') {
        return 'Summary'
      }
      const trimmed = label.trim()
      return trimmed.length > 0 ? trimmed : 'Summary'
    }, [canvasOverlay?.statisticSummaryLabel])
    const allRecordsCheckboxTooltip = useMemo(() => {
      const label = canvasOverlay?.allRecordsCheckboxTooltip
      if (typeof label !== 'string') {
        return 'Select or clear all records'
      }
      const trimmed = label.trim()
      return trimmed.length > 0 ? trimmed : 'Select or clear all records'
    }, [canvasOverlay?.allRecordsCheckboxTooltip])

    // ---------------------------------------------------------------------------
    // Column resize debounce (Teable pattern):
    // Local state updates instantly (smooth UI), host callback fires after 300ms
    // ---------------------------------------------------------------------------
    const originalGridColumns = useMemo(
      () => mapColumns(columns, summaryLabel),
      [columns, summaryLabel]
    )
    const customIcons = getFieldHeaderSpriteMap()
    const canvasTheme = useMemo<Partial<IGridTheme> | undefined>(
      () => buildCanvasThemeFromCssVars(externalTheme === 'dark' ? 'dark' : 'light'),
      [externalTheme, cssThemeVersion]
    )
    const [gridColumns, setGridColumns] = useState<IGridColumn[]>(originalGridColumns)
    const [resizeIndex, setResizeIndex] = useState<number | undefined>()
    const [resizeNewSize, setResizeNewSize] = useState<number | undefined>()
    const suppressColumnMoveUntilRef = useRef(0)

    // Sync from props when columns change externally.
    // TEC-076: Skip sync while resize in progress to avoid losing intermediate state.
    useEffect(() => {
      if (resizeIndex != null) return
      setGridColumns(originalGridColumns)
    }, [originalGridColumns, resizeIndex])

    // Debounced callback to host — fires 300ms after last resize event
    useDebounce(
      () => {
        if (resizeIndex == null || resizeNewSize == null || !onColumnResized) return
        const col = columns[resizeIndex]
        if (!col) return
        onColumnResized({ [col.field]: resizeNewSize })
        setResizeIndex(undefined)
        setResizeNewSize(undefined)
      },
      300,
      [resizeIndex, resizeNewSize]
    )

    // Map row controls
    const gridRowControls = useMemo(
      () => mapRowControls(rowControls),
      [rowControls]
    )

    const gridDraggable = useMemo(
      () => resolveGridDraggableType(onRowMoved, onColumnMoved),
      [onRowMoved, onColumnMoved]
    )

    // Column statistics
    const gridColumnStatistics = useMemo(
      () => mapColumnStatistics(columnStatistics, columns, resolvedStatisticLabels),
      [columnStatistics, columns, resolvedStatisticLabels]
    )

    // Freeze
    const freezeColumnCount = useMemo(
      () => getFreezeColumnCount(config),
      [config]
    )

    // ---------------------------------------------------------------------------
    // Group support: extract dataRows + groupPoints from mixed rows array
    // ---------------------------------------------------------------------------
    const { dataRows, groupPoints, collapsedGroupIds, prefillingRowIndexes, groupFieldMetas } = useMemo(
      () => extractGroupedData(rows),
      [rows]
    )
    const focusedCellIdentityRef = useRef<{ recordId: string; field: string } | null>(null)
    // 子记录父链标题兜底：记录 id → 主字段标题。仅在有父链字段时构建，供 link
    // 单元格在只拿到裸 id 时解析出可读标题。用 ref 隔离出 getCellContent 依赖。
    const primaryColumn = useMemo(
      () => columns.find((c) => c.isPrimaryField),
      [columns]
    )
    const recordTitleById = useMemo(() => {
      const map = new Map<string, string>()
      if (!subRecordParentFieldId || !primaryColumn) return map
      for (const dataRow of dataRows) {
        const rowRecord = dataRow as Record<string, unknown>
        const id = resolveRecordId(rowRecord) ?? ''
        if (!id) continue
        const title = resolvePrimaryFieldRecordTitle(rowRecord[primaryColumn.field], {
          fieldType: primaryColumn.originalFieldType ?? primaryColumn.type,
          userDisplayNameById,
        })
        if (title) map.set(id, title)
      }
      return map
    }, [dataRows, primaryColumn, subRecordParentFieldId, userDisplayNameById])
    const recordTitleByIdRef = useRef(recordTitleById)
    recordTitleByIdRef.current = recordTitleById

    // Row count = data rows only (Teable manages group/append rows via groupPoints)
    const rowCount = dataRows.length
    const prefillingRowIndex = prefillingRowIndexes.length > 0 ? prefillingRowIndexes[0] : null
    const isPrefillingVisible =
      prefillingRowIndex != null && prefillingOverlay?.visible !== false
    const [prefillingPositionVersion, setPrefillingPositionVersion] = useState(0)
    const prefillingRowStyle = useMemo<React.CSSProperties | undefined>(() => {
      if (!isPrefillingVisible || prefillingRowIndex == null || !gridRef.current) {
        return undefined
      }
      const rowOffset = gridRef.current.getRowOffset(prefillingRowIndex)
      // Ensure the header bar (at top: -32px relative to this container) is not
      // clipped by the overflow-hidden grandparent. The minimum top must be
      // PREFILLING_HEADER_HEIGHT so the header stays within bounds.
      return {
        top: Math.max(PREFILLING_HEADER_HEIGHT, rowOffset),
        height: 0,
      }
    }, [isPrefillingVisible, prefillingRowIndex, prefillingPositionVersion])

    // ---------------------------------------------------------------------------
    // Group collection: provides cell content for group header rows
    // Teable-aligned: groupColumns only contains the group fields (not all columns),
    // and getGroupCell renders values based on field type (Select → colored tags, etc.)
    // ---------------------------------------------------------------------------
    const groupCollection = useMemo<IGroupCollection | null>(() => {
      if (!groupPoints) return null

      // Build a map from field name → column for quick lookup
      const columnByFieldName = new Map<string, TableGridColumn>()
      for (const col of columns) {
        const name = col.headerName ?? col.field
        columnByFieldName.set(name, col)
        // Also map by field key (id) for robustness
        if (col.field && col.field !== name) {
          columnByFieldName.set(col.field, col)
        }
      }

      // Build groupColumns: only the group field columns (Teable-aligned)
      const groupGridColumns: IGridColumn[] = groupFieldMetas.map((meta) => {
        const col = columnByFieldName.get(meta.fieldName)
        const fieldType = col?.originalFieldType ?? col?.type ?? 'text'
        return {
          id: col?.fieldId ?? col?.field ?? meta.fieldName,
          name: col?.headerName ?? meta.fieldName,
          width: col?.width ?? 200,
          icon: FIELD_TYPE_ICON_MAP[fieldType] ?? 'text',
        }
      })

      // Fallback: if no group field metas extracted, use all grid columns.
      // TEC-079: Use originalGridColumns so useMemo doesn't recompute on every resize pixel.
      const resolvedGroupColumns = groupGridColumns.length > 0 ? groupGridColumns : originalGridColumns
      const organizationMemberById = new Map(
        (organizationMembers ?? []).map((member) => [member.id, member] as const),
      )

      return {
        groupColumns: resolvedGroupColumns,
        getGroupCell: (cellValue: unknown, depth: number): ICell => {
          const emptyLabel = '(Empty)'

          // Find the column for this depth's group field
          const meta = groupFieldMetas[depth]
          const col = meta ? columnByFieldName.get(meta.fieldName) : undefined
          const displayStr = resolveColumnDisplayValue(col, cellValue, undefined, emptyLabel)
          const fieldType = col?.originalFieldType ?? col?.type ?? 'text'

          // Render based on field type (Teable-aligned group cell rendering)
          switch (fieldType) {
            case 'single_select':
            case 'select': {
              if (cellValue == null || cellValue === '') {
                return {
                  type: CellType.Text,
                  id: `group-${depth}-empty`,
                  data: emptyLabel,
                  displayData: emptyLabel,
                  readonly: true,
                } as ICell
              }
              const strVal = String(cellValue)
              const { choiceMap } = buildSelectChoices(col!)
              return {
                type: CellType.Select,
                id: `group-${depth}-${strVal}`,
                data: [strVal],
                displayData: [strVal],
                choiceMap,
                isMultiple: false,
                readonly: true,
              } satisfies ISelectCell as ICell
            }

            case 'multi_select': {
              if (cellValue == null || cellValue === '') {
                return {
                  type: CellType.Text,
                  id: `group-${depth}-empty`,
                  data: emptyLabel,
                  displayData: emptyLabel,
                  readonly: true,
                } as ICell
              }
              let dataArr: string[] = []
              if (Array.isArray(cellValue)) {
                dataArr = cellValue.map((v: unknown) => String(v))
              } else if (typeof cellValue === 'string') {
                dataArr = cellValue.split(',').map((s) => s.trim()).filter(Boolean)
              }
              const { choiceMap } = buildSelectChoices(col!)
              return {
                type: CellType.Select,
                id: `group-${depth}-${displayStr}`,
                data: dataArr,
                displayData: dataArr,
                choiceMap,
                isMultiple: true,
                readonly: true,
              } satisfies ISelectCell as ICell
            }

            case 'checkbox':
            case 'boolean': {
              return {
                type: CellType.Boolean,
                id: `group-${depth}-${displayStr}`,
                data: toSafeBool(cellValue),
                readonly: true,
              } satisfies IBooleanCell as ICell
            }

            case 'rating': {
              const max = (col?.cellEditorParams?.max as number) || 5
              return {
                type: CellType.Rating,
                id: `group-${depth}-${displayStr}`,
                data: cellValue != null ? Number(cellValue) : 0,
                icon: 'star',
                color: '#FFB400',
                max,
                readonly: true,
              } satisfies IRatingCell as ICell
            }

            case 'number':
            case 'currency':
            case 'percent':
            case 'count': {
              return {
                type: CellType.Number,
                id: `group-${depth}-${displayStr}`,
                data: cellValue != null ? Number(cellValue) : null,
                displayData: displayStr,
                readonly: true,
                contentAlign: 'left',
              } satisfies INumberCell as ICell
            }

            case 'user':
            case 'created_by':
            case 'last_modified_by': {
              if (cellValue == null || cellValue === '') {
                return {
                  type: CellType.Text,
                  id: `group-${depth}-empty`,
                  data: emptyLabel,
                  displayData: emptyLabel,
                  readonly: true,
                } as ICell
              }
              const users: IUserData[] = []
              const items = Array.isArray(cellValue) ? cellValue : [cellValue]
              for (const item of items) {
                if (typeof item === 'string') {
                  const member = organizationMemberById.get(item)
                  const resolution = resolveUserDisplay(item, {
                    currentMemberName: member?.name,
                    resolvedNameById: userDisplayNameById,
                    isCurrentMember: organizationMemberById.has(item),
                  })
                  users.push({
                    id: item,
                    name: userDisplayLabel(resolution),
                    avatarUrl: resolution.canUseDirectoryAvatar ? member?.avatarUrl : undefined,
                  })
                } else if (item && typeof item === 'object') {
                  const obj = item as Record<string, unknown>
                  const id = String(obj.id ?? obj.user_id ?? obj.open_id ?? '')
                  const member = id ? organizationMemberById.get(id) : undefined
                  const embeddedName = obj.name ?? obj.display_name ?? obj.email
                  const embeddedAvatar =
                    (obj.avatar_url as string | undefined) ??
                    (obj.avatarUrl as string | undefined) ??
                    (obj.avatar as string | undefined)
                  // 有独立姓名的外部用户不借组织头像；同名/无姓名时才回落
                  const canUseMemberAvatar =
                    !embeddedName ||
                    (typeof embeddedName === 'string' && embeddedName === member?.name)
                  const resolution = resolveUserDisplay(id, {
                    embeddedName,
                    currentMemberName: member?.name,
                    resolvedNameById: userDisplayNameById,
                    isCurrentMember: id ? organizationMemberById.has(id) : false,
                  })
                  users.push({
                    id,
                    name: userDisplayLabel(resolution),
                    avatarUrl:
                      embeddedAvatar ||
                      (resolution.canUseDirectoryAvatar || canUseMemberAvatar
                        ? member?.avatarUrl
                        : undefined),
                  })
                }
              }
              if (users.length === 0) {
                // displayStr 在人员分组里就是原始 user id，不能拿它当可见文案
                users.push({ id: displayStr, name: UNKNOWN_MEMBER_LABEL })
              }
              return {
                type: CellType.User,
                id: `group-${depth}-${displayStr}`,
                data: users,
                displayData: users.map((u) => u.name).join(', '),
                readonly: true,
              } satisfies IUserCell as ICell
            }

            // Default: render supported text-like field types.
            default: {
              return {
                type: CellType.Text,
                id: `group-${depth}-${displayStr}`,
                data: displayStr,
                displayData: displayStr,
                readonly: true,
              } satisfies ITextCell as ICell
            }
          }
        },
      }
    }, [
      groupPoints,
      groupFieldMetas,
      columns,
      originalGridColumns,
      organizationMembers,
      userDisplayNameById,
    ])

    // ---------------------------------------------------------------------------
    // Search overlay: bridge TableGridConfig.canvasOverlay → Grid searchCursor
    // ---------------------------------------------------------------------------
    const searchCursor = useMemo<[number, number] | null>(() => {
      const c = canvasOverlay?.searchCursor
      if (!c) return null
      return [c.colIndex, c.rowIndex]
    }, [canvasOverlay?.searchCursor])

    // Bridge searchHitIndex from canvasOverlay to Grid for field-level highlights
    const searchHitIndex = useMemo<{ fieldId: string; recordId: string }[] | undefined>(
      () => canvasOverlay?.searchHitIndex,
      [canvasOverlay?.searchHitIndex]
    )

    // Bridge collaborators from canvasOverlay → ICollaborator for Canvas Grid
    const gridCollaborators = useMemo<ICollaborator | undefined>(() => {
      const src = canvasOverlay?.collaborators
      if (!src?.length) return undefined
      return src.map(c => ({
        activeCellId: c.activeCellId as [string, string],
        user: { id: c.userId, name: c.userName, avatar: '' },
        userId: c.userId,
        userName: c.userName,
        borderColor: c.borderColor,
        timeStamp: c.timeStamp,
      }))
    }, [canvasOverlay?.collaborators])

    // getCellContent callback – the heart of the adapter.
    // dataRows must remain a dependency: RenderLayer treats this callback identity
    // as the cell-data invalidation signal for canvas redraws.
    const getCellContent = useCallback(
      (cell: ICellItem): ICell => {
        const [colIndex, rowIndex] = cell
        const column = columns[colIndex]
        let row = dataRows[rowIndex]
        const focusedIdentity = focusedCellIdentityRef.current
        const activeCell = gridRef.current?.getActiveCell?.()
        if (
          focusedIdentity &&
          gridRef.current?.isEditing?.() &&
          activeCell?.[0] === colIndex &&
          activeCell?.[1] === rowIndex &&
          column?.field === focusedIdentity.field &&
          resolveRecordId(row) !== focusedIdentity.recordId
        ) {
          row = dataRows.find(
            candidate => resolveRecordId(candidate) === focusedIdentity.recordId
          ) ?? row
        }

        return createCellContent(row, column, rowIndex, colIndex, {
          onSelectOptionAdd,
          onAttachmentUpload,
          onAttachmentFileRef,
          onDownloadAttachment,
          onDownloadAllAttachments,
          loadAttachmentPreviewUi,
          onAttachmentPreview: handleAttachmentPreview,
          onLinkCellExpand,
          onLinkTagClick,
          onUrlCellClick,
          editorLabels,
          organizationMembers,
          userDisplayNameById,
          subRecordParentFieldId,
          resolveLinkTitleById: (id: string) => recordTitleByIdRef.current.get(id),
        })
      },
      [
        dataRows,
        columns,
        onAttachmentUpload,
        onAttachmentFileRef,
        onDownloadAttachment,
        onDownloadAllAttachments,
        loadAttachmentPreviewUi,
        handleAttachmentPreview,
        onSelectOptionAdd,
        onLinkCellExpand,
        onLinkTagClick,
        onUrlCellClick,
        editorLabels,
        organizationMembers,
        userDisplayNameById,
        subRecordParentFieldId,
      ]
    )

    // --- Callback bridges ---

    const reportCellValueChanged = useCallback(
      (
        row: TableGridRow,
        column: TableGridColumn,
        nextValue: unknown,
        oldValue?: unknown,
      ) => {
        if (!onCellValueChanged) return

        const fieldType = String(column.originalFieldType ?? column.type ?? '').toLowerCase()
        if (fieldType !== 'attachment') {
          onCellValueChanged(row, column.field, nextValue, oldValue)
          return
        }

        // 上传进度和本地完成叠层只用于展示，不能写入记录或作为历史旧值。
        if (isTransientAttachmentValueOnly(nextValue)) {
          return
        }

        onCellValueChanged(
          row,
          column.field,
          sanitizeAttachmentValueForPersistence(nextValue),
          sanitizeAttachmentValueForPersistence(oldValue),
        )
      },
      [onCellValueChanged],
    )

    const handleCellEdited = useCallback(
      (cell: ICellItem, newValue: IInnerCell) => {
        if (!onCellValueChanged) return
        const [colIndex, rowIndex] = cell
        const row = dataRows[rowIndex]
        const col = columns[colIndex]
        if (!row || !col) return
        const oldValue = (row as Record<string, unknown>)[col.field]
        const fieldType = String(col.originalFieldType ?? col.type ?? '').toLowerCase()
        let nextValue: unknown = newValue.data
        if (fieldType === 'percent') {
          // Number editor emits percent points; persist as ratio.
          if (nextValue == null || nextValue === '') {
            nextValue = null
          } else if (typeof nextValue === 'number' && Number.isFinite(nextValue)) {
            nextValue = nextValue / 100
          } else if (typeof nextValue === 'string') {
            const cleaned = nextValue.replace(/\s*%\s*$/, '').trim()
            if (!cleaned) {
              nextValue = null
            } else {
              const n = Number(cleaned)
              nextValue = Number.isFinite(n) ? n / 100 : nextValue
            }
          }
        }
        reportCellValueChanged(row, col, nextValue, oldValue)
      },
      [onCellValueChanged, dataRows, columns, reportCellValueChanged]
    )

    const handleDeleteSelection = useCallback(
      (selection: CombinedSelection) => {
        if (!onCellValueChanged || !selection.isCellSelection) return

        const [start, end] = selection.serialize()
        if (!start || !end) return

        for (let rowIndex = start[1]; rowIndex <= end[1]; rowIndex += 1) {
          const row = dataRows[rowIndex]
          if (!row) continue

          for (let colIndex = start[0]; colIndex <= end[0]; colIndex += 1) {
            const col = columns[colIndex]
            if (!col || getCellContent([colIndex, rowIndex]).readonly) continue

            const oldValue = (row as Record<string, unknown>)[col.field]
            reportCellValueChanged(row, col, null, oldValue)
          }
        }
      },
      [onCellValueChanged, dataRows, columns, getCellContent, reportCellValueChanged]
    )

    const handleItemHovered = useCallback(
      (type: RegionType, bounds: IRectangle, cellItem: ICellItem) => {
        if (type === RegionType.AllCheckbox) {
          const container = gridRef.current?.getContainer()
          const rect = container?.getBoundingClientRect()
          if (rect) {
            openDescriptionTooltip({
              columnIndex: -1,
              position: {
                x: rect.left + bounds.x + bounds.width / 2,
                y: rect.top + bounds.y + bounds.height,
              },
              text: allRecordsCheckboxTooltip,
            })
            return
          }
        }

        if (type === RegionType.ColumnDescription) {
          const [colIndex] = cellItem
          const col = gridColumns[colIndex]
          const text = col?.description
          if (text) {
            const container = gridRef.current?.getContainer()
            const rect = container?.getBoundingClientRect()
            if (rect) {
              openDescriptionTooltip({
                columnIndex: colIndex,
                position: {
                  x: rect.left + bounds.x + bounds.width / 2,
                  y: rect.top + bounds.y + bounds.height,
                },
                text,
              })
              return
            }
          }
        }
        closeDescriptionTooltip()
      },
      [allRecordsCheckboxTooltip, gridColumns, openDescriptionTooltip, closeDescriptionTooltip]
    )

    const handleEditingStopped = useCallback(
      (event: {
        cell: ICellItem | null
        cellId: string | null
        reason: 'api' | 'interaction' | 'editor'
      }) => {
        if (!onCellEditingStopped || !event.cell || !event.cellId) {
          return
        }

        let resolvedRowIndex = -1
        let resolvedColumnIndex = -1
        for (let rowIndex = 0; rowIndex < dataRows.length && resolvedRowIndex < 0; rowIndex += 1) {
          const recordId = resolveRecordId(dataRows[rowIndex])
          if (!recordId) continue
          for (let colIndex = 0; colIndex < columns.length; colIndex += 1) {
            const col = columns[colIndex]
            if (`${recordId}-${col.fieldId ?? col.field}` !== event.cellId) continue
            resolvedRowIndex = rowIndex
            resolvedColumnIndex = colIndex
            break
          }
        }

        const row = dataRows[resolvedRowIndex]
        const col = columns[resolvedColumnIndex]
        if (!row || !col) {
          return
        }

        onCellEditingStopped({
          data: row,
          rowIndex: resolvedRowIndex,
          reason: event.reason,
          field: col.field,
          colDef: {
            field: col.field,
            colId: col.field,
          },
          column: {
            getColId: () => col.field,
          },
        })
      },
      [onCellEditingStopped, dataRows, columns]
    )

    const handleFillSelection = useCallback(
      (selectionRanges: [IRange, IRange], targetEndRealRowIndex: number) => {
        if (!onCellValueChanged) return

        void (async () => {
          const [start, end] = selectionRanges
          if (!Array.isArray(start) || !Array.isArray(end)) return

          // 快照当前数据，防止异步循环中并发删行/改列导致越界
          const snapshotColumns = [...columns]
          const snapshotDataRows = [...dataRows]

          const maxColumnIndex = snapshotColumns.length - 1
          const maxRowIndex = snapshotDataRows.length - 1
          if (maxColumnIndex < 0 || maxRowIndex < 0) return

          const startCol = Math.max(0, Math.min(start[0], end[0]))
          const endCol = Math.min(maxColumnIndex, Math.max(start[0], end[0]))
          const topRow = Math.max(0, Math.min(start[1], end[1]))
          const bottomRow = Math.min(maxRowIndex, Math.max(start[1], end[1]))
          if (startCol > endCol || topRow > bottomRow) return

          const targetRow = Math.max(0, Math.min(maxRowIndex, targetEndRealRowIndex))

          const isDownward = targetRow > bottomRow
          const isUpward = targetRow < topRow
          if (!isDownward && !isUpward) return

          const rowsToFill = isDownward ? targetRow - bottomRow : topRow - targetRow
          if (rowsToFill <= 0) return

          const sourceRowValues: unknown[][] = []
          for (let rowIndex = topRow; rowIndex <= bottomRow; rowIndex += 1) {
            const row = snapshotDataRows[rowIndex] as Record<string, unknown> | undefined
            const rowValues: unknown[] = []
            for (let colIndex = startCol; colIndex <= endCol; colIndex += 1) {
              const field = snapshotColumns[colIndex]?.field
              rowValues.push(row && field ? row[field] : null)
            }
            sourceRowValues.push(rowValues)
          }

          if (sourceRowValues.length === 0) return
          const allEmpty = sourceRowValues.every((row) => row.every((value) => isFillEmptyValue(value)))
          if (allEmpty) return

          const direction: FillDirection = isDownward ? 'down' : 'up'
          const columnSeries: unknown[][] = []
          const columnCount = endCol - startCol + 1

          for (let colOffset = 0; colOffset < columnCount; colOffset += 1) {
            const columnIndex = startCol + colOffset
            const sourceColumnValues = sourceRowValues.map((rowValues) => rowValues[colOffset])
            const fieldType = resolveFillFieldType(snapshotColumns[columnIndex])
            columnSeries.push(
              generateSeriesForColumn(sourceColumnValues, fieldType, rowsToFill, direction)
            )
          }

          const targetStartRow = isDownward ? bottomRow + 1 : targetRow
          for (let rowOffset = 0; rowOffset < rowsToFill; rowOffset += 1) {
            const targetRowIndex = targetStartRow + rowOffset
            const targetRow = snapshotDataRows[targetRowIndex]
            if (!targetRow) continue

            const targetRowData = targetRow as Record<string, unknown>
            const sourceSeriesIndex = isDownward ? rowOffset : rowsToFill - 1 - rowOffset

            for (let colOffset = 0; colOffset < columnCount; colOffset += 1) {
              const columnIndex = startCol + colOffset
              const column = snapshotColumns[columnIndex]
              if (!column || column.editable === false) continue

              const nextValue = columnSeries[colOffset]?.[sourceSeriesIndex]
              const previousValue = targetRowData[column.field]
              if (Object.is(nextValue, previousValue)) continue

              try {
                await Promise.resolve(
                  reportCellValueChanged(targetRow, column, nextValue, previousValue)
                )
              } catch {
                // 和单元格编辑保持一致：单格失败不阻断其余填充。
              }
            }
          }
        })()
      },
      [onCellValueChanged, dataRows, columns, reportCellValueChanged]
    )

    const handleSelectionChanged = useCallback(
      (selection: CombinedSelection) => {
        const { isRowSelection, ranges, type } = selection

        if (type === SelectionRegionType.Cells && ranges.length >= 2) {
          const activeRange = (ranges[1] ?? ranges[0]) as unknown as [number, number]
          const [colIdx, rowIdx] = activeRange
          const row = dataRows[rowIdx]
          const col = columns[colIdx]
          const recordId = row ? resolveRecordId(row) : null
          focusedCellIdentityRef.current = recordId && col
            ? { recordId, field: col.field }
            : null
        } else {
          focusedCellIdentityRef.current = null
        }

        if (!onSelectionChanged && !onSelectionStateChange) return

        // 行选中 → onSelectionChanged
        if (isRowSelection && onSelectionChanged && ranges.length >= 2) {
          const [start, end] = ranges as unknown as [number[], number[]]
          const startIdx = Math.min(start[0], end[0])
          const endIdx = Math.max(start[0], end[0])
          const selectedRows = dataRows.slice(startIdx, endIdx + 1)
          onSelectionChanged(selectedRows)
        }

        // 单元格选中 → onSelectionStateChange（用于 Presence 广播）
        if (onSelectionStateChange) {
          if (type === SelectionRegionType.Cells && ranges.length >= 2) {
            // 选择范围为 [start, end]，end 才是当前焦点单元格；缺失时兜底 start
            const activeRange = (ranges[1] ?? ranges[0]) as unknown as [number, number]
            const [colIdx, rowIdx] = activeRange
            const row = dataRows[rowIdx]
            const col = columns[colIdx]
            const activeCell = row && col
              ? { rowIndex: rowIdx, colIndex: colIdx, rowId: resolveRecordId(row) ?? '', field: col.field }
              : null
            const selectionEvent = {
              reason: 'click' as any,
              previous: null as any,
              next: activeCell ? { type, ranges, activeCell } : null as any,
            }
            onSelectionStateChange({ activeCell }, selectionEvent)
          } else {
            // 清除选中（如行选中、列选中、无选中）
            onSelectionStateChange(
              { activeCell: null },
              { reason: 'click' as any, previous: null as any, next: null as any }
            )
          }
        }
      },
      [onSelectionChanged, onSelectionStateChange, dataRows, columns]
    )

    useLayoutEffect(() => {
      const identity = focusedCellIdentityRef.current
      const grid = gridRef.current
      if (!identity || !grid?.isEditing()) return

      const activeCell = grid.getActiveCell()
      if (!activeCell) return

      const [activeColumnIndex, activeRowIndex] = activeCell
      const activeRecordId = resolveRecordId(dataRows[activeRowIndex])
      const activeField = columns[activeColumnIndex]?.field
      if (activeRecordId === identity.recordId && activeField === identity.field) return

      const nextRowIndex = dataRows.findIndex(
        row => resolveRecordId(row) === identity.recordId
      )
      const nextColumnIndex = columns.findIndex(column => column.field === identity.field)
      if (nextRowIndex < 0 || nextColumnIndex < 0) {
        // The edited record disappeared from the refreshed result. Do not let a
        // reused row index save into a different record.
        grid.cancelEditing()
        grid.setActiveCell(null)
        return
      }

      const range = [nextColumnIndex, nextRowIndex] as IRange
      grid.setSelection(
        new CombinedSelection(SelectionRegionType.Cells, [range, range])
      )
    }, [columns, dataRows])

    const handleColumnResize = useCallback(
      (column: IGridColumn, newSize: number, colIndex: number) => {
        suppressColumnMoveUntilRef.current = Date.now() + COLUMN_RESIZE_MOVE_SUPPRESS_MS
        // Instant local update for smooth UI (Teable pattern)
        const idx = gridColumns.findIndex((c) => c.id === column.id)
        if (idx >= 0) {
          const updated = [...gridColumns]
          updated[idx] = { ...updated[idx], width: newSize }
          setGridColumns(updated)
        }
        // Deferred host callback via debounce
        setResizeIndex(colIndex)
        setResizeNewSize(newSize)
      },
      [gridColumns]
    )

    const handleColumnOrdered = useCallback(
      (dragColIndexCollection: number[], dropColIndex: number) => {
        if (Date.now() < suppressColumnMoveUntilRef.current) return
        if (!onColumnMoved) return
        const reorderedColumns = reorderByDragIndexes(
          columns,
          dragColIndexCollection,
          dropColIndex
        )
        const fieldKeys = reorderedColumns
          .map((column) => column?.fieldId ?? column?.field)
          .filter(Boolean)
        onColumnMoved(fieldKeys as string[])
      },
      [onColumnMoved, columns]
    )

    const handleRowOrdered = useCallback(
      (
        dragRowIndexCollection: number[],
        dropRowIndex: number,
        context?: { dropMode?: 'before' | 'after' | 'inside'; targetRowIndex?: number }
      ) => {
        if (!onRowMoved) return

        // Collect visible children from dataRows (already filtered by tree expansion).
        // Collapsed descendants are NOT included here — the consumer
        // (e.g. useCanvasRowReorder.expandMovedRowIdsWithDescendants) must
        // expand the set using the full tree_data before persisting.
        const expandedIndices = new Set(dragRowIndexCollection)
        for (const idx of dragRowIndexCollection) {
          const row = dataRows[idx]
          if (!row || !row.__treeHasChildren || typeof row.__treeDepth !== 'number') continue
          const parentDepth = row.__treeDepth as number
          // Collect consecutive children (deeper depth) following this parent
          for (let ci = idx + 1; ci < dataRows.length; ci++) {
            const child = dataRows[ci]
            if (!child || typeof child.__treeDepth !== 'number') break
            if ((child.__treeDepth as number) <= parentDepth) break
            expandedIndices.add(ci)
          }
        }

        // Sort indices to maintain order, then extract row IDs
        const sortedIndices = Array.from(expandedIndices).sort((a, b) => a - b)
        const rowIds = sortedIndices
          .map((i) => resolveRecordId(dataRows[i]))
          .filter((id): id is string => Boolean(id))
        const targetRowId =
          typeof context?.targetRowIndex === 'number'
            ? resolveRecordId(dataRows[context.targetRowIndex]) ?? undefined
            : undefined
        onRowMoved(rowIds, {
          dropRowIndex,
          ...(context?.dropMode ? { dropMode: context.dropMode } : {}),
          ...(typeof context?.targetRowIndex === 'number'
            ? { targetRowIndex: context.targetRowIndex }
            : {}),
          ...(targetRowId ? { targetRowId: String(targetRowId) } : {}),
        })
      },
      [onRowMoved, dataRows]
    )

    const handleRowExpandClick = useCallback(
      (rowIndex: number) => {
        if (!onRowExpand) return
        const row = dataRows[rowIndex]
        if (!row) return
        if (row.__rowType === 'draft') return
        onRowExpand(row)
      },
      [onRowExpand, dataRows]
    )

    const handleCommentCountClick = useCallback(
      (rowIndex: number) => {
        if (!onCommentCountClick) return
        const row = dataRows[rowIndex]
        if (row) onCommentCountClick(row)
      },
      [onCommentCountClick, dataRows]
    )

    const handleTreeToggle = useCallback(
      (rowIndex: number) => {
        if (!onTreeToggleProp) return
        const row = dataRows[rowIndex]
        if (!row) return
        const rowId = resolveRecordId(row)
        if (rowId) onTreeToggleProp(rowId)
      },
      [onTreeToggleProp, dataRows]
    )

    const handleInsertSubRecordFromGrid = useCallback(
      (rowIndex: number) => {
        if (!onInsertSubRecord) return
        const row = dataRows[rowIndex]
        if (!row) return
        const rowId = resolveRecordId(row)
        if (rowId) void onInsertSubRecord(rowId)
      },
      [onInsertSubRecord, dataRows]
    )

    const getRowTreeData = useCallback(
      (rowIndex: number): IRowTreeData | null => {
        const row = dataRows[rowIndex]
        if (!row || typeof row.__treeDepth !== 'number') return null
        return {
          treeDepth: row.__treeDepth,
          treeHasChildren: row.__treeHasChildren,
          treeExpanded: row.__treeExpanded,
          rootDisplayIndex: row.__treeRootIndex ?? rowIndex,
        }
      },
      [dataRows]
    )

    // Group collapse/expand toggle
    // Canvas fires onCollapsedGroupChanged with the full new Set<string>.
    // We compute the diff (which single group was toggled) and route it through
    // onRowExpand with a synthesized group_header row — this is the same path
    // that handleCanvasRowExpand uses in the host DataGridAdapter, which calls
    // ViewStore.toggleGroupCollapse → re-computes groupedRows → Canvas re-renders.
    const handleCollapsedGroupChanged = useCallback(
      (nextCollapsedIds: Set<string>) => {
        if (!onRowExpand) return
        const currentIds = collapsedGroupIds ?? new Set<string>()

        // Find the group that was newly collapsed (added to the set)
        for (const id of nextCollapsedIds) {
          if (!currentIds.has(id)) {
            onRowExpand({
              __rowType: 'group_header',
              __groupPath: id,
              __groupCollapsed: false,
            } as unknown as TableGridRow)
            return
          }
        }

        // Find the group that was expanded (removed from the set)
        for (const id of currentIds) {
          if (!nextCollapsedIds.has(id)) {
            onRowExpand({
              __rowType: 'group_header',
              __groupPath: id,
              __groupCollapsed: true,
            } as unknown as TableGridRow)
            return
          }
        }
      },
      [onRowExpand, collapsedGroupIds]
    )

    const handleGridScrollChanged = useCallback(() => {
      closeDescriptionTooltip()
      if (!isPrefillingVisible) return
      setPrefillingPositionVersion((value) => value + 1)
    }, [isPrefillingVisible, closeDescriptionTooltip])

    const handleVisibleRegionChanged = useCallback(
      (region: IRectangle) => {
        const startRowIndex = Math.max(0, Math.floor(region.y))
        const stopRowIndex = Math.min(
          Math.max(0, rowCount - 1),
          Math.max(startRowIndex, Math.floor(region.y + region.height))
        )
        onVisibleRegionChanged?.({
          startRowIndex,
          stopRowIndex,
          rowCount,
        })
      },
      [onVisibleRegionChanged, rowCount]
    )

    useEffect(() => {
      if (!isPrefillingVisible) return
      setPrefillingPositionVersion((value) => value + 1)
    }, [isPrefillingVisible, prefillingRowIndex, rowCount, groupPoints, collapsedGroupIds])

    const handleRowAppend = useCallback(
      (context?: {
        rowIndex?: number
        groupPath?: string | null
        groupValues?: Record<string, unknown>
      }) => {
        if (!onRowAppend) return
        const targetIndex =
          typeof context?.rowIndex === 'number' && context.rowIndex >= 0
            ? context.rowIndex
            : undefined
        const targetRow = targetIndex != null ? dataRows[targetIndex] : undefined
        const targetRowData = targetRow as Record<string, unknown> | undefined
        const appendGroupPath =
          context?.groupPath ??
          (typeof targetRowData?.__groupPath === 'string'
            ? targetRowData.__groupPath
            : undefined)
        const appendGroupValues =
          context?.groupValues ??
          (targetRowData?.__groupValues &&
          typeof targetRowData.__groupValues === 'object'
            ? (targetRowData.__groupValues as Record<string, unknown>)
            : undefined)
        const displayRowIndex = resolveAppendDisplayRowIndex(
          rows as Array<Record<string, unknown>>,
          {
            groupPath: appendGroupPath,
            groupValues: appendGroupValues,
            anchorRow: targetRowData,
            fallbackIndex: targetIndex,
          }
        )

        // When groups exist, prefer explicit group context from the append row itself.
        if (groupPoints && (context?.groupPath || context?.groupValues)) {
          onRowAppend({
            rowIndex: displayRowIndex,
            groupPath: context?.groupPath ?? null,
            groupValues: context?.groupValues,
          })
          return
        }

        if (targetIndex != null && groupPoints) {
          if (targetRow) {
            const r = targetRow as Record<string, unknown>
            onRowAppend({
              rowIndex: displayRowIndex,
              rowData: targetRow,
              groupPath: (r.__groupPath as string) ?? null,
              groupValues:
                r.__groupValues && typeof r.__groupValues === 'object'
                  ? (r.__groupValues as Record<string, unknown>)
                  : undefined,
            })
            return
          }
        }

        onRowAppend({ rowIndex: displayRowIndex, groupPath: context?.groupPath ?? null, groupValues: context?.groupValues })
      },
      [onRowAppend, dataRows, groupPoints, rows]
    )

    const toggleColumnHeaderMenu = useCallback(
      (colIndex: number, bounds: IRectangle) => {
        const col = columns[colIndex]
        if (!col) return
        // A mobile text editor may still own focus when the user taps a column
        // header. Close it first so its input/keyboard cannot cover the field
        // menu or turn the next tap into an accidental edit action.
        gridRef.current?.stopEditing()
        const focusedElement = typeof document !== 'undefined' ? document.activeElement : null
        if (focusedElement instanceof HTMLElement) focusedElement.blur()
        // 再次点击「交互开始时已打开」的同一列列头 → 关闭菜单（toggle），不再重开。
        // useClickAway 已在 mousedown 冒泡阶段把菜单关掉了，这里 closeHeaderMenu
        // 多为幂等收尾，关键是 return 阻止下面的重新打开。
        if (openHeaderFieldAtMouseDownRef.current === col.field) {
          openHeaderFieldAtMouseDownRef.current = null
          closeHeaderMenu()
          return
        }
        // Open store-driven FieldMenu (positioned below header)
        openHeaderMenu({
          ownerId: overlayOwnerId,
          fields: [col.field],
          fieldNames: [col.headerName ?? col.field],
          fieldTypes: [col.originalFieldType ?? col.type ?? 'text'],
          isPrimary: [col.isPrimaryField ?? false],
          editable: [col.editable !== false],
          position: { x: bounds.x, y: bounds.y + bounds.height },
        })
      },
      [columns, openHeaderMenu, closeHeaderMenu, overlayOwnerId]
    )

    const handleColumnHeaderClick = toggleColumnHeaderMenu
    const handleColumnHeaderMenuClick = toggleColumnHeaderMenu

    const handleColumnStatisticClick = useCallback(
      (colIndex: number, bounds: IRectangle) => {
        const col = columns[colIndex]
        if (!col) return
        // Open store-driven StatisticMenu
        openStatisticMenu({
          ownerId: overlayOwnerId,
          field: col.field,
          fieldName: col.headerName ?? col.field,
          fieldType: col.originalFieldType ?? col.type ?? 'text',
          position: bounds,
        })
        // Also fire legacy callback for backward compatibility
        onColumnStatisticClick?.(col.field, {
          clientX: bounds.x,
          clientY: bounds.y,
          targetRect: new DOMRect(bounds.x, bounds.y, bounds.width, bounds.height),
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        })
      },
      [onColumnStatisticClick, columns, openStatisticMenu, overlayOwnerId]
    )

    // ---------------------------------------------------------------------------
    // Context menu bridge: Open store-driven menus (Teable pattern)
    // ---------------------------------------------------------------------------
    const openSingleRecordMenu = useCallback(
      ({
        row,
        rowId,
        rowIndex,
        displayRowIndex,
        position,
        selectedRowIds,
        selectedFieldKeys,
      }: {
        row: Record<string, unknown>
        rowId?: string
        rowIndex?: number
        displayRowIndex?: number
        position: IPosition
        selectedRowIds?: string[]
        /** 单元格选区对应的列 field key（name 或 id），供发送到对话建索引 */
        selectedFieldKeys?: string[]
      }) => {
        const menuRowId = rowId ?? ''
        const menuData: IRecordMenuData = {
          rowData: row,
          rowId: menuRowId,
          rowIndex,
          isMultipleSelected: false,
          position,
          deleteRecords: onDeleteRecords && menuRowId
            ? async () => { await onDeleteRecords([menuRowId]) }
            : undefined,
          insertRecord: onInsertRecord && displayRowIndex != null
            ? (pos: 'before' | 'after', num: number) => { onInsertRecord(pos, displayRowIndex, num) }
            : undefined,
          insertSubRecord: onInsertSubRecord && menuRowId
            ? async () => { await onInsertSubRecord(menuRowId) }
            : undefined,
          duplicateRecord: onDuplicateRecord && menuRowId
            ? async () => { await onDuplicateRecord(menuRowId) }
            : undefined,
          copyRecordUrl: onCopyRecordUrl && menuRowId
            ? async () => { await onCopyRecordUrl(menuRowId) }
            : undefined,
          commentRecord: onRecordComment
            ? () => { onRecordComment(row) }
            : undefined,
          viewRecordHistory: onRowContextMenu
            ? async () => {
                onRowContextMenu(row, {
                  clientX: position.x,
                  clientY: position.y,
                  targetRect: new DOMRect(position.x, position.y, 1, 1),
                  rowIndex: rowIndex ?? -1,
                  rowId: menuRowId,
                  api: { action: 'view-history' },
                })
              }
            : undefined,
          sendToChat: onRowContextMenu
            ? () => {
                onRowContextMenu(row, {
                  clientX: position.x,
                  clientY: position.y,
                  targetRect: new DOMRect(position.x, position.y, 1, 1),
                  rowIndex: rowIndex ?? -1,
                  rowId: menuRowId,
                  api: {
                    action: 'send-to-chat',
                    ...(selectedRowIds && selectedRowIds.length > 0 ? { selectedRowIds } : {}),
                    ...(selectedFieldKeys && selectedFieldKeys.length > 0
                      ? { selectedFieldKeys }
                      : {}),
                  },
                })
              }
            : undefined,
        }
        openRecordMenu(menuData)
      },
      [onRowContextMenu, onRecordComment, onInsertSubRecord, onDeleteRecords, onDuplicateRecord, onInsertRecord, onCopyRecordUrl, openRecordMenu]
    )

    const handleContextMenu = useCallback(
      (selection: CombinedSelection, position: IPosition) => {
        const { isColumnSelection } = selection

        // Column header context menu → open FieldMenu
        if (isColumnSelection && selection.ranges.length > 0) {
          const selectedColumnIndexes: number[] = []
          for (const range of selection.ranges) {
            const [start, end] = range
            const startIdx = Math.min(start, end)
            const endIdx = Math.max(start, end)
            for (let colIndex = startIdx; colIndex <= endIdx; colIndex += 1) {
              selectedColumnIndexes.push(colIndex)
            }
          }
          const uniqueColumnIndexes = [...new Set(selectedColumnIndexes)].sort((a, b) => a - b)
          const selectedFields: string[] = []
          const selectedNames: string[] = []
          const selectedTypes: string[] = []
          const selectedPrimary: boolean[] = []
          const selectedEditable: boolean[] = []
          for (const i of uniqueColumnIndexes) {
            const col = columns[i]
            if (!col) continue
            selectedFields.push(col.field)
            selectedNames.push(col.headerName ?? col.field)
            selectedTypes.push(col.originalFieldType ?? col.type ?? 'text')
            selectedPrimary.push(col.isPrimaryField ?? false)
            selectedEditable.push(col.editable !== false)
          }
          if (selectedFields.length > 0) {
            openHeaderMenu({
              ownerId: overlayOwnerId,
              fields: selectedFields,
              fieldNames: selectedNames,
              fieldTypes: selectedTypes,
              isPrimary: selectedPrimary,
              editable: selectedEditable,
              position,
            })
          }
          return
        }

        // Cell / row context menu → open RecordMenu. The callback selection
        // reflects the right-click target before React commits activeCell state.
        if (selection.isRowSelection && selection.ranges.length > 0) {
          const rowSelectionState = resolveRowSelectionStateForRecordMenu(
            selection.ranges as Array<[number, number]>,
            dataRows as Array<Record<string, unknown>>,
            rows as Array<Record<string, unknown>>
          )
          const {
            selectedRowIds,
            primaryRowIndex,
            primaryRow,
            primaryRowId,
            primaryDisplayRowIndex,
            isMultipleSelected,
          } = rowSelectionState
          if (selectedRowIds.length > 0 && primaryRow) {
            if (!isMultipleSelected) {
              openSingleRecordMenu({
                row: primaryRow,
                rowId: primaryRowId,
                rowIndex: primaryRowIndex,
                displayRowIndex: primaryDisplayRowIndex,
                position,
                selectedRowIds,
              })
              return
            }
            openRecordMenu({
              rowData: undefined,
              rowId: undefined,
              rowIndex: primaryRowIndex,
              isMultipleSelected,
              position,
              deleteRecords: onDeleteRecords
                ? async () => { await onDeleteRecords(selectedRowIds) }
                : undefined,
              sendToChat:
                onRowContextMenu && selectedRowIds.length > 0
                  ? () => {
                      onRowContextMenu(primaryRow, {
                        clientX: position.x,
                        clientY: position.y,
                        targetRect: new DOMRect(position.x, position.y, 1, 1),
                        rowIndex: primaryRowIndex ?? -1,
                        rowId: primaryRowId,
                        api: { action: 'send-to-chat', selectedRowIds },
                      })
                    }
                  : undefined,
            })
          }
          return
        }

        if (selection.isCellSelection && selection.ranges.length > 0) {
          const {
            rowIndex,
            row,
            rowId,
            displayRowIndex,
            selectedRowIds,
            selectedColumnIndexes,
            primarySelectedRowIndex,
            primarySelectedRow,
            primarySelectedRowId,
            isMultipleSelected,
          } = resolveCellSelectionStateForRecordMenu(
            selection.ranges as Array<[number, number]>,
            dataRows as Array<Record<string, unknown>>,
            rows as Array<Record<string, unknown>>
          )
          if (!row) return

          const selectedFieldKeys = selectedColumnIndexes
            .map((colIndex) => columns[colIndex]?.field)
            .filter((field): field is string => typeof field === 'string' && field.length > 0)

          if (isMultipleSelected) {
            openRecordMenu({
              rowData: undefined,
              rowId: undefined,
              rowIndex: primarySelectedRowIndex,
              isMultipleSelected,
              position,
              deleteRecords: onDeleteRecords
                ? async () => { await onDeleteRecords(selectedRowIds) }
                : undefined,
              sendToChat:
                onRowContextMenu && primarySelectedRow
                  ? () => {
                      onRowContextMenu(primarySelectedRow, {
                        clientX: position.x,
                        clientY: position.y,
                        targetRect: new DOMRect(position.x, position.y, 1, 1),
                        rowIndex: primarySelectedRowIndex ?? -1,
                        rowId: primarySelectedRowId,
                        api: {
                          action: 'send-to-chat',
                          selectedRowIds,
                          ...(selectedFieldKeys.length > 0 ? { selectedFieldKeys } : {}),
                        },
                      })
                    }
                  : undefined,
            })
            return
          }

          openSingleRecordMenu({
            row,
            rowId,
            rowIndex,
            displayRowIndex,
            position,
            selectedRowIds,
            selectedFieldKeys,
          })
          return
        }

        const activeCell = gridRef.current?.getActiveCell?.()
        if (!activeCell) return

        const [colIndex, rowIndex] = activeCell
        const row = dataRows[rowIndex]
        if (!row) return

        const rowId = getRecordMenuRowId(row as Record<string, unknown>) ?? ''
        const displayRowIndex = resolveDisplayRowIndexForRecordMenu(
          rows as Array<Record<string, unknown>>,
          row as Record<string, unknown>,
          rowIndex
        )
        const activeFieldKey = columns[colIndex]?.field
        openSingleRecordMenu({
          row: row as Record<string, unknown>,
          rowId,
          rowIndex,
          displayRowIndex,
          position,
          selectedFieldKeys:
            typeof activeFieldKey === 'string' && activeFieldKey.length > 0
              ? [activeFieldKey]
              : undefined,
        })
      },
      [onRowContextMenu, onDeleteRecords, dataRows, columns, openHeaderMenu, openRecordMenu, openSingleRecordMenu, rows, overlayOwnerId]
    )

    // ---------------------------------------------------------------------------
    // Clipboard bridges
    // ---------------------------------------------------------------------------
    const resolveClipboardDisplayRowIndex = useCallback(
      (row: TableGridRow, dataRowIndex: number) =>
        resolveDisplayRowIndexForRecordMenu(
          rows as Array<Record<string, unknown>>,
          row as Record<string, unknown>,
          dataRowIndex
        ) ?? dataRowIndex,
      [rows]
    )

    const handleCopy = useCallback(
      (selection: CombinedSelection, e: React.ClipboardEvent) => {
        if (!onClipboardCopy) return

        let minRow = 0, maxRow = 0, minCol = 0, maxCol = 0

        if (selection.isCellSelection && selection.ranges.length >= 2) {
          const [start, end] = selection.serialize()
          minCol = start[0]; minRow = start[1]
          maxCol = end[0]; maxRow = end[1]
        } else if (selection.isRowSelection) {
          const flat = selection.flatten()
          if (flat.length === 0) return
          minRow = Math.min(...flat); maxRow = Math.max(...flat)
          minCol = 0; maxCol = columns.length - 1
        } else if (selection.isColumnSelection) {
          const flat = selection.flatten()
          if (flat.length === 0) return
          minCol = Math.min(...flat); maxCol = Math.max(...flat)
          minRow = 0; maxRow = dataRows.length - 1
        } else {
          const activeCell = gridRef.current?.getActiveCell?.()
          if (activeCell) {
            const [ci, ri] = activeCell
            minCol = ci; maxCol = ci; minRow = ri; maxRow = ri
          } else {
            return
          }
        }

        minRow = Math.max(0, minRow)
        maxRow = Math.min(dataRows.length - 1, maxRow)
        minCol = Math.max(0, minCol)
        maxCol = Math.min(columns.length - 1, maxCol)
        if (minRow > maxRow || minCol > maxCol) return

        const cells: Array<{
          rowIndex: number; colIndex: number; rowId?: string;
          field: string; value: unknown; displayValue?: string;
        }> = []
        const tsvLines: string[] = []

        if (shouldIncludeClipboardHeaders(config?.clipboard?.copyHeaders, {
          minRow, maxRow, minCol, maxCol,
        })) {
          const headerValues: string[] = []
          for (let ci = minCol; ci <= maxCol; ci++) {
            const col = columns[ci]
            headerValues.push(col ? clipboardEscapeTsv(col.headerName ?? col.field) : '')
          }
          tsvLines.push(headerValues.join('\t'))
        }

        for (let ri = minRow; ri <= maxRow; ri++) {
          const row = dataRows[ri]
          if (!row) continue
          const rowValues: string[] = []
          for (let ci = minCol; ci <= maxCol; ci++) {
            const col = columns[ci]
            if (!col) { rowValues.push(''); continue }
            const rawValue = (row as Record<string, unknown>)[col.field]
            const fieldType = String(col.originalFieldType ?? col.type ?? '').toLowerCase()
            // Percent copy uses user-facing percent points ("12%") so paste can /100.
            let displayValue = clipboardFormatCellValue(rawValue)
            if (fieldType === 'percent' && rawValue != null && rawValue !== '') {
              const ratio = Number(rawValue)
              if (Number.isFinite(ratio)) {
                displayValue = `${(ratio * 100).toFixed(2).replace(/\.?0+$/, '')}%`
              }
            }
            cells.push({
              rowIndex: resolveClipboardDisplayRowIndex(row, ri),
              colIndex: ci,
              rowId: resolveRecordId(row) ?? undefined,
              field: col.field,
              value: rawValue,
              displayValue,
            })
            rowValues.push(clipboardEscapeTsv(displayValue))
          }
          tsvLines.push(rowValues.join('\t'))
        }

        const tsvText = tsvLines.join('\n')
        e.preventDefault()
        e.clipboardData?.setData?.('text/plain', tsvText)

        // HTML channel: embed raw cell values so paste within TabTin can
        // reconstruct typed values. Controlled by config.clipboard.includeHtml
        // (defaults to true).
        let html: string | undefined
        if (config?.clipboard?.includeHtml !== false) {
          const htmlRows: string[] = []
          let cellIdx = 0
          for (let ri = minRow; ri <= maxRow; ri++) {
            const htmlCells: string[] = []
            for (let ci = minCol; ci <= maxCol; ci++) {
              const c = cells[cellIdx]
              const escaped = (c?.displayValue ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              htmlCells.push(`<td>${escaped}</td>`)
              cellIdx++
            }
            htmlRows.push(`<tr>${htmlCells.join('')}</tr>`)
          }
          const rawJson = JSON.stringify(cells.map(c => ({ f: c.field, v: c.value })))
          const safeJson = rawJson.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
          html = `<table data-tabtin-cells="${safeJson}">${htmlRows.join('')}</table>`
          e.clipboardData?.setData?.('text/html', html)
        }

        onClipboardCopy({
          operation: 'copy',
          text: tsvText,
          html,
          cells,
        })
      },
      [onClipboardCopy, dataRows, columns, resolveClipboardDisplayRowIndex]
    )

    const handlePaste = useCallback(
      (selection: CombinedSelection, e: React.ClipboardEvent) => {
        // File paste → attachment cell: upload directly without entering edit mode
        const pastedFiles = Array.from(e.clipboardData?.files ?? [])
        if (pastedFiles.length > 0 && onAttachmentUpload && onCellValueChanged) {
          const activeCell = gridRef.current?.getActiveCell?.()
          if (activeCell) {
            const [colIndex, rowIndex] = activeCell
            const col = columns[colIndex]
            const row = dataRows[rowIndex]
            const fieldType = col?.originalFieldType ?? col?.type ?? 'text'
            if (col && row && fieldType === 'attachment') {
              e.preventDefault()
              e.stopPropagation()
              const uploadFiles = pastedFiles
              if (uploadFiles.length === 0) {
                return
              }
              const currentValue = (row as Record<string, unknown>)[col.field]
              const persistedCurrentValue = sanitizeAttachmentValueForPersistence(currentValue)
              const currentAttachments = Array.isArray(persistedCurrentValue)
                ? persistedCurrentValue
                : persistedCurrentValue != null
                  ? [persistedCurrentValue]
                  : []
              void (async () => {
                try {
                  // 上传进度只属于宿主的本地展示叠层。若经 onCellValueChanged 落库，
                  // 版本历史会把首次新增误记成“临时附件 → 正式附件”。
                  const uploaded = await onAttachmentUpload({
                    rowData: row,
                    field: col.field,
                    fieldId: col.fieldId,
                    files: uploadFiles,
                    currentValue,
                  })
                  const uploadedItems = Array.isArray(uploaded) ? uploaded.filter(Boolean) : []
                  if (uploadedItems.length > 0) {
                    reportCellValueChanged(row, col, [...currentAttachments, ...uploadedItems], currentValue)
                  }
                } catch (err) {
                  const errMsg = err instanceof Error ? err.message : String(err)
                  if (onClipboardPaste) {
                    onClipboardPaste({
                      operation: 'paste',
                      text: '',
                      cells: [],
                      uploadError: errMsg,
                    })
                  }
                }
              })()
              return
            }
          }
          // 有文件但当前字段不是 attachment：通过 payload 传递 hasFiles 供上层提示
          const text = e.clipboardData?.getData?.('text/plain') ?? ''
          if (!text && onClipboardPaste) {
            e.preventDefault()
            const active = gridRef.current?.getActiveCell?.()
            const anchorCells: Array<{ rowIndex: number; colIndex: number; rowId?: string; field: string; value: unknown }> = []
            if (active) {
              const [ci, ri] = active
              const r = dataRows[ri]
              const c = columns[ci]
              if (r && c) {
                anchorCells.push({
                  rowIndex: resolveClipboardDisplayRowIndex(r, ri),
                  colIndex: ci,
                  rowId: resolveRecordId(r) ?? undefined,
                  field: c.field,
                  value: null,
                })
              }
            }
            onClipboardPaste({
              operation: 'paste',
              text: '',
              html: e.clipboardData?.getData?.('text/html'),
              cells: anchorCells,
              hasFiles: true,
            })
            return
          }
        }

        if (!onClipboardPaste) return

        e.preventDefault()
        const activeCell = gridRef.current?.getActiveCell?.()
        const anchorCells: Array<{
          rowIndex: number; colIndex: number; rowId?: string;
          field: string; value: unknown;
        }> = []

        if (activeCell) {
          const [ci, ri] = activeCell
          const row = dataRows[ri]
          const col = columns[ci]
          if (row && col) {
            anchorCells.push({
              rowIndex: resolveClipboardDisplayRowIndex(row, ri),
              colIndex: ci,
              rowId: resolveRecordId(row) ?? undefined,
              field: col.field,
              value: null,
            })
          }
        }

        onClipboardPaste({
          operation: 'paste',
          text: e.clipboardData?.getData?.('text/plain') ?? '',
          html: e.clipboardData?.getData?.('text/html'),
          cells: anchorCells,
        })
      },
      [onClipboardPaste, onAttachmentUpload, onCellValueChanged, columns, dataRows, editorLabels?.attachmentFileTypeNotAllowed, resolveClipboardDisplayRowIndex, reportCellValueChanged]
    )

    const handleColumnFreeze = useCallback(
      (freezeCount: number) => {
        if (!onFreezeStateChange) return
        const fields = columns.slice(0, freezeCount).map((c) => c.field)
        onFreezeStateChange({ leftColumnFields: fields })
      },
      [onFreezeStateChange, columns]
    )

    // Expose runtime API
    useEffect(() => {
      if (!onTableApiReady) return
      if (!gridRef.current) {
        onTableApiReady(null)
        return
      }

      const grid = gridRef.current
      const displayRows = rows as Array<Record<string, unknown>>
      const dataRowRecords = dataRows as Array<Record<string, unknown>>
      const api: TableGridRuntimeApi = {
        clearFocusedCell: () => grid.setActiveCell(null),
        deselectAll: () => grid.resetState(),
        stopEditing: () => {
          grid.stopEditing()
        },
        getFocusedCell: () => {
          const activeCell = grid.getActiveCell()
          if (!activeCell) return null
          const [colIndex, rowIndex] = activeCell
          const row = dataRows[rowIndex] as Record<string, unknown> | undefined
          const displayRowIndex = resolveDisplayRowIndexForRecordMenu(displayRows, row, rowIndex)
          return {
            rowIndex: displayRowIndex ?? rowIndex,
            rowPinned: null,
            field: columns[colIndex]?.field ?? null,
          }
        },
        getEditingCells: () => {
          const editingCells = grid.getEditingCells()
          if (!editingCells.length) return []
          return editingCells.map(([colIndex, rowIndex]) => {
            const row = dataRows[rowIndex] as Record<string, unknown> | undefined
            const displayRowIndex = resolveDisplayRowIndexForRecordMenu(displayRows, row, rowIndex)
            return {
              rowIndex: displayRowIndex ?? rowIndex,
              rowPinned: null,
              field: columns[colIndex]?.field ?? null,
            }
          })
        },
        getDisplayedRowCount: () => rows.length,
        getDisplayedRowAtIndex: (index: number) => {
          const row = rows[index]
          if (!row) return null
          return {
            data: row,
            setSelected: () => {
              // Canvas grid currently does not expose row-level selection mutation.
            },
          }
        },
        getPinnedBottomRowCount: () => 0,
        getPinnedBottomRow: () => null,
        startEditingCell: ({ rowIndex, colKey }) => {
          const colIndex = columns.findIndex((c) => c.field === colKey)
          if (colIndex < 0) return
          const realRowIndex = resolveRealRowIndexFromDisplayIndex(
            displayRows,
            dataRowRecords,
            rowIndex
          )
          if (realRowIndex == null) return
          grid.startEditingCell([colIndex, realRowIndex])
        },
        ensureIndexVisible: (index: number) => {
          const realRowIndex = resolveRealRowIndexFromDisplayIndex(
            displayRows,
            dataRowRecords,
            index
          )
          if (realRowIndex == null) return
          grid.scrollToItem([0, realRowIndex])
        },
        setFocusedCell: (rowIndex: number, colKey: string) => {
          const colIndex = columns.findIndex((c) => c.field === colKey)
          if (colIndex < 0) return
          const realRowIndex = resolveRealRowIndexFromDisplayIndex(
            displayRows,
            dataRowRecords,
            rowIndex
          )
          if (realRowIndex == null) return
          // 聚焦即「选中」该单元格：设置单格选区（而非仅 activeCell），呈现与用户点击一致的
          // 完整选中态——选中边框由 activeCell 绘制、右下角填充手柄依赖选区（drawFillHandler 取
          // 自 selection 的 maxRange）。InteractionLayer 在 Cells 选区下会同步 setActiveCell，
          // 故无需再单独调用 setActiveCell。
          const range = [colIndex, realRowIndex] as IRange
          grid.setSelection(new CombinedSelection(SelectionRegionType.Cells, [range, range]))
          // 程序化聚焦不会经过 InteractionLayer，setSelection 本身也不会同步 activeCell。
          // 显式更新 activeCell，保证黑色焦点框与键盘输入落在同一个目标单元格。
          grid.setActiveCell(range)
        },
        applyColumnSort: (field: string, direction: 'asc' | 'desc') => {
          const normalizedField = typeof field === 'string' ? field.trim() : ''
          if (!normalizedField) return
          if (!columns.some((column) => column.field === normalizedField)) return

          const normalizedDirection = direction === 'desc' ? 'desc' : 'asc'
          const nextSortModel: TableGridSortModelItem[] = [
            {
              field: normalizedField,
              direction: normalizedDirection,
            },
          ]

          sortModelRef.current = nextSortModel
          onSortChanged?.(nextSortModel)
        },
      }
      onTableApiReady(api)
    }, [onTableApiReady, onSortChanged, rows, dataRows, columns])

    // Fire onGridReady once
    useEffect(() => {
      onGridReady?.({})
      gridContainerRef.current = gridRef.current?.getContainer() ?? null
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    // Row height
    const rowHeight = config?.rowHeight
    const AttachmentPreviewProvider = attachmentPreviewUi?.Provider
    const AttachmentPreviewDialog = attachmentPreviewUi?.Dialog

    // ---------------------------------------------------------------------------
    // StatisticMenu onSelect handler: bridges to host's onColumnStatisticClick
    // ---------------------------------------------------------------------------
    const handleStatisticSelect = useCallback(
      (field: string, func: import('./overlays/statistics').StatFunc) => {
        onColumnStatisticClick?.(field, {
          clientX: 0,
          clientY: 0,
          targetRect: new DOMRect(),
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          api: { statisticFunc: func },
        })
      },
      [onColumnStatisticClick]
    )

    // ---------------------------------------------------------------------------
    // FieldMenu callbacks: bridge to host's column header context menu handler
    // ---------------------------------------------------------------------------
    const fieldMenuCallbacks = useMemo(
      (): import('./overlays/FieldMenu').FieldMenuCallbacks => ({
        onEditField: onColumnHeaderContextMenu
          ? (field) =>
              onColumnHeaderContextMenu(field, {
                clientX: 0,
                clientY: 0,
                targetRect: new DOMRect(),
                api: { action: 'edit' },
              })
          : undefined,
        onDuplicateField: onColumnHeaderContextMenu
          ? (field) =>
              onColumnHeaderContextMenu(field, {
                clientX: 0,
                clientY: 0,
                targetRect: new DOMRect(),
                api: { action: 'duplicate' },
              })
          : undefined,
        onInsertField: onColumnHeaderContextMenu
          ? (field, position) =>
              onColumnHeaderContextMenu(field, {
                clientX: 0,
                clientY: 0,
                targetRect: new DOMRect(),
                api: { action: 'insert', position },
              })
          : undefined,
        onFilterField: onColumnHeaderContextMenu
          ? (field) =>
              onColumnHeaderContextMenu(field, {
                clientX: 0,
                clientY: 0,
                targetRect: new DOMRect(),
                api: { action: 'filter' },
              })
          : undefined,
        onSortField: onColumnHeaderContextMenu
          ? (field) =>
              onColumnHeaderContextMenu(field, {
                clientX: 0,
                clientY: 0,
                targetRect: new DOMRect(),
                api: { action: 'sort' },
              })
          : undefined,
        onGroupField: onColumnHeaderContextMenu
          ? (field) =>
              onColumnHeaderContextMenu(field, {
                clientX: 0,
                clientY: 0,
                targetRect: new DOMRect(),
                api: { action: 'group' },
              })
          : undefined,
        onFreezeField: onFreezeStateChange
          ? (field) => {
              // Freeze up to this field
              const colIndex = columns.findIndex((c) => c.field === field)
              if (colIndex >= 0) {
                const fields = columns.slice(0, colIndex + 1).map((c) => c.field)
                onFreezeStateChange({ leftColumnFields: fields })
              }
            }
          : undefined,
        onSetPrimaryField: onColumnHeaderContextMenu
          ? (field) =>
              onColumnHeaderContextMenu(field, {
                clientX: 0,
                clientY: 0,
                targetRect: new DOMRect(),
                api: { action: 'set-primary' },
              })
          : undefined,
        onHideFields: onColumnHeaderContextMenu
          ? (fields) =>
              onColumnHeaderContextMenu(fields[0], {
                clientX: 0,
                clientY: 0,
                targetRect: new DOMRect(),
                api: { action: 'hide', fields },
              })
          : undefined,
        onDeleteFields: onColumnHeaderContextMenu
          ? (fields) =>
              onColumnHeaderContextMenu(fields[0], {
                clientX: 0,
                clientY: 0,
                targetRect: new DOMRect(),
                api: { action: 'delete', fields },
              })
          : undefined,
      }),
      [onColumnHeaderContextMenu, columns, onFreezeStateChange]
    )

    return (
      <div className="relative size-full overflow-hidden">
        <Grid
          ref={gridRef}
          style={style}
          columns={gridColumns}
          theme={canvasTheme}
          customIcons={customIcons}
          rowCount={rowCount}
          rowHeight={rowHeight}
          rowControls={gridRowControls}
          draggable={gridDraggable}
          rowIndexVisible={rowIndexVisible}
          commentCountMap={commentCountMap}
          columnStatistics={gridColumnStatistics}
          freezeColumnCount={freezeColumnCount}
          searchCursor={searchCursor}
          searchHitIndex={searchHitIndex}
          collaborators={gridCollaborators}
          editorShiftEnterHint={editorShiftEnterHint}
          editorSelectSearchPlaceholder={editorSelectSearchPlaceholder}
          editorSelectSearchPlaceholderEmpty={editorSelectSearchPlaceholderEmpty}
          editorSelectNoResults={editorSelectNoResults}
          editorSelectEmptyHint={editorSelectEmptyHint}
          editorSelectAddOption={editorSelectAddOption}
          editorSelectDoneLabel={editorSelectDoneLabel}
          groupPoints={groupPoints}
          groupCollection={groupCollection}
          collapsedGroupIds={collapsedGroupIds}
          prefillingRowIndexes={prefillingRowIndexes}
          onCollapsedGroupChanged={handleCollapsedGroupChanged}
          getCellContent={getCellContent}
          getRowTreeData={getRowTreeData}
          onCellEdited={handleCellEdited}
          onSelectionChanged={handleSelectionChanged}
          onColumnResize={handleColumnResize}
          onColumnOrdered={handleColumnOrdered}
          onRowOrdered={handleRowOrdered}
          onRowExpand={handleRowExpandClick}
          onCommentCountClick={handleCommentCountClick}
          onTreeToggle={handleTreeToggle}
          onInsertSubRecord={onInsertSubRecord ? handleInsertSubRecordFromGrid : undefined}
          onRowAppend={onRowAppend ? handleRowAppend : undefined}
          onColumnAppend={onColumnAppend}
          onColumnHeaderClick={handleColumnHeaderClick}
          onColumnHeaderMenuClick={handleColumnHeaderMenuClick}
          onColumnStatisticClick={handleColumnStatisticClick}
          onContextMenu={handleContextMenu}
          onColumnFreeze={handleColumnFreeze}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onDelete={onCellValueChanged ? handleDeleteSelection : undefined}
          onFillSelection={onCellValueChanged ? handleFillSelection : undefined}
          onEditingStopped={handleEditingStopped}
          onItemHovered={handleItemHovered}
          onScrollChanged={handleGridScrollChanged}
          onVisibleRegionChanged={handleVisibleRegionChanged}
          smoothScrollX
          smoothScrollY
        />

        {AttachmentPreviewProvider && AttachmentPreviewDialog && (
          <AttachmentPreviewProvider>
            <AttachmentPreviewDialog
              ref={attachmentPreviewDialogRef}
              files={attachmentPreviewFiles}
            />
          </AttachmentPreviewProvider>
        )}

        {isPrefillingVisible && prefillingRowStyle && (
          <DeferredPrefillingRowContainer
            style={prefillingRowStyle}
            showBorder={false}
            isLoading={Boolean(prefillingOverlay?.isLoading)}
            title={prefillingOverlay?.title ?? 'Add row'}
            cancelLabel={prefillingOverlay?.cancelLabel ?? 'Cancel'}
            onCancel={prefillingOverlay?.onCancel}
            onClickOutside={prefillingOverlay?.onClickOutside}
            excludeRef={gridContainerRef}
          />
        )}

        {/* Overlay menus (store-driven, Teable pattern) */}
        <DeferredRecordMenu
          labels={recordMenuLabels}
          anchorRef={gridContainerRef}
        />
        <DeferredFieldMenu
          labels={fieldMenuLabels}
          callbacks={fieldMenuCallbacks}
          anchorRef={gridContainerRef}
          ownerId={overlayOwnerId}
        />
        <DeferredStatisticMenu
          labels={resolvedStatisticLabels}
          onSelect={handleStatisticSelect}
          anchorRef={gridContainerRef}
          ownerId={overlayOwnerId}
        />
        <DeferredDescriptionTooltip />
      </div>
    )
  }
)

// ---------------------------------------------------------------------------
// Engine registration
// ---------------------------------------------------------------------------
export const CANVAS_TABLE_ENGINE_ID = 'canvas'

export const CANVAS_TABLE_ENGINE: TableGridEngine = {
  id: CANVAS_TABLE_ENGINE_ID,
  label: 'Canvas',
  experimental: false,
  capabilities: {
    supportsPinnedBottomRows: false,
    supportsFullWidthRows: false,
    supportsColumnResize: true,
    supportsColumnReorder: true,
    supportsVirtualScroll: true,
    supportsCellEditing: true,
    supportsGroupingVisualRows: true,
    supportsRangeSelection: true,
    supportsClipboard: true,
    supportsKeyboardShortcuts: true,
    supportsFrozenColumns: true,
    supportsFrozenRows: false,
  },
  component: CanvasGridAdapter as React.ComponentType<TableGridRendererProps>,
}
