import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
import * as t from '../../theme'
import { useSystemFonts, type FontItem } from '../../fonts/font-list'
import { normalizeRichTextHyperlinkInput } from '../../utils/hyperlink'
import { useSlideStore } from '../../store/slide'
import { useT } from '../../i18n'
import { ScrollArea } from '../ui/ScrollArea'
import { ZIndex } from '@tabtin/app-shell'
import {
  FONT_SIZES,
  LINE_HEIGHTS,
  LETTER_SPACINGS,
  TEXT_COLORS,
  HIGHLIGHT_COLORS,
  THEME_COLOR_DEFS,
  BoldIcon,
  ItalicIcon,
  UnderlineIcon,
  StrikeIcon,
  LinkIcon,
  AlignLeftIcon,
  AlignCenterIcon,
  AlignRightIcon,
  AlignJustifyIcon,
  ChevronDownIcon,
  BulletListIcon,
  OrderedListIcon,
  IndentIcon,
  OutdentIcon,
  SuperscriptIcon,
  SubscriptIcon,
} from '../toolbar/text-toolbar-presets'

// ═══════════════════════════════════════════════
// 系统字体枚举（从共享模块导入）
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
// 常量 & 预设
// ═══════════════════════════════════════════════

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent)
const MOD = isMac ? '⌘' : 'Ctrl+'

const MENU_HEIGHT = 40
const MENU_GAP = 8
/** 距视口顶部小于此值时翻转到选区下方 */
const FLIP_THRESHOLD = 60

// ═══════════════════════════════════════════════
// 通用组件
// ═══════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cmd = (editor: Editor) => editor.chain().focus() as any

const btnBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderRadius: 4,
  width: 28,
  height: 28,
  padding: 0,
  cursor: 'pointer',
  transition: `background ${t.transitionFast}`,
  flexShrink: 0,
  fontSize: 13,
  fontFamily: t.fontFamily,
}

interface ToolBtnProps {
  active?: boolean
  onClick: () => void
  title?: string
  children: React.ReactNode
  style?: React.CSSProperties
}

const ToolBtn = React.forwardRef<HTMLButtonElement, ToolBtnProps>(
  ({ active, onClick, title, children, style }, ref) => (
    <button
      ref={ref}
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      style={{
        ...btnBase,
        background: active ? t.accentBg : 'transparent',
        color: active ? t.accent : t.textPrimary,
        ...style,
      }}
    >
      {children}
    </button>
  ),
)
ToolBtn.displayName = 'ToolBtn'

const Divider = () => (
  <div style={{ width: 1, height: 18, background: t.border, margin: '0 2px', flexShrink: 0 }} />
)

// ═══════════════════════════════════════════════
// 通用下拉菜单
// ═══════════════════════════════════════════════

interface DropdownItem { label: string; value: string; group?: string }

interface MiniDropdownProps {
  /** 当前值（用于显示和标记选中） */
  value: string
  /** 显示文本（覆盖 value 显示） */
  displayText?: string
  items: DropdownItem[]
  onChange: (value: string) => void
  width?: number
  /** 列表项是否使用自身字体预览 */
  fontPreview?: boolean
  placeholder?: string
  title?: string
}

const MiniDropdown: React.FC<MiniDropdownProps> = ({
  value, displayText, items, onChange, width = 70, fontPreview, placeholder, title,
}) => {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dropdownHeight = useMemo(() => {
    const groupedHeaders = new Set(items.map((item) => item.group).filter(Boolean)).size
    const estimated = items.length * 30 + groupedHeaders * 18 + 10
    return Math.max(84, Math.min(300, estimated))
  }, [items])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const label = displayText ?? value ?? placeholder ?? '—'

  // 分组渲染
  const renderItems = () => {
    const elements: React.ReactNode[] = []
    let lastGroup: string | undefined

    items.forEach((item) => {
      // 分组标题
      if (item.group && item.group !== lastGroup) {
        if (lastGroup !== undefined) {
          // 分组间分隔线
          elements.push(
            <div key={`sep-${item.group}`} style={{ height: 1, background: t.border, margin: '4px 8px' }} />,
          )
        }
        elements.push(
          <div
            key={`grp-${item.group}`}
            style={{
              padding: '4px 12px 2px',
              fontSize: 10,
              color: t.textTertiary,
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              fontFamily: t.fontFamily,
            }}
          >
            {item.group}
          </div>,
        )
        lastGroup = item.group
      }

      const selected = item.value === value
      elements.push(
        <button
          key={item.value || '__default'}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onChange(item.value); setOpen(false) }}
          style={{
            display: 'block',
            width: '100%',
            border: 'none',
            padding: '5px 12px',
            textAlign: 'left',
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: fontPreview && item.value ? `"${item.value}", ${t.fontFamily}` : t.fontFamily,
            background: selected ? t.accentBg : 'transparent',
            color: selected ? t.accent : t.textPrimary,
            fontWeight: selected ? 600 : 400,
          }}
        >
          {item.label}
        </button>,
      )
    })

    return elements
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        title={title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        style={{
          ...btnBase,
          width,
          height: 26,
          padding: '0 4px 0 8px',
          gap: 2,
          borderRadius: 4,
          background: open ? t.bgMuted : 'transparent',
          color: t.textPrimary,
          fontSize: 12,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <ChevronDownIcon />
      </button>

      {open && (
        <ScrollArea
          native
          onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            minWidth: width + 20,
            height: dropdownHeight,
            background: t.bgApp,
            border: `1px solid ${t.border}`,
            borderRadius: t.radiusLg,
            boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
            zIndex: ZIndex.sticky,
          }}
          viewportStyle={{ padding: '4px 0', overscrollBehavior: 'contain' }}
        >
          {renderItems()}
        </ScrollArea>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════
// 颜色弹出层
// ═══════════════════════════════════════════════

interface ColorPopoverProps {
  editor: Editor
  open: boolean
  onToggle: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
  translate: (key: string) => string
}

/** 从 SlideTheme 解析 OOXML 主题色 key → hex 映射 */
function resolveThemeColorMap(theme?: { fontColor: string; backgroundColor: string; themeColors: string[] } | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!theme) return map
  map.set('dk1', theme.fontColor)
  map.set('lt1', theme.backgroundColor)
  const accents = theme.themeColors ?? []
  for (let i = 0; i < Math.min(accents.length, 6); i++) {
    map.set(`accent${i + 1}`, accents[i])
  }
  return map
}

const ColorPopover: React.FC<ColorPopoverProps> = ({
  editor,
  open,
  onToggle,
  anchorRef,
  translate,
}) => {
  const panelRef = useRef<HTMLDivElement>(null)
  const theme = useSlideStore((s) => s.presentation?.theme)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) onToggle()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onToggle, anchorRef])

  const themeColorMap = useMemo(() => resolveThemeColorMap(theme), [theme])

  if (!open) return null

  const setTextColor = (c: string) => {
    // 用户显式改色时，清理主题色引用标记，避免旧 theme key 残留。
    if (c) {
      cmd(editor).setMark('textStyle', { themeColorKey: null }).setColor(c).run()
    } else {
      cmd(editor).setMark('textStyle', { themeColorKey: null }).unsetColor().run()
    }
  }
  const setThemeColor = (key: string, hex: string) => {
    cmd(editor).setMark('textStyle', { themeColorKey: key }).setColor(hex).run()
  }
  const setHighlight = (c: string) => { c ? cmd(editor).setHighlight({ color: c }).run() : cmd(editor).unsetHighlight().run() }

  const curThemeKey = (editor.getAttributes('textStyle').themeColorKey as string) || ''

  const swatch = (color: string, isBg: boolean): React.CSSProperties => ({
    width: 20, height: 20, borderRadius: 4, border: `1px solid ${t.border}`,
    cursor: 'pointer', background: isBg ? (color || 'transparent') : '#fff', padding: 0, position: 'relative',
  })

  return (
    <div
      ref={panelRef}
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'absolute', top: '100%', right: 0, marginTop: 6,
        padding: '10px 12px', background: t.bgApp, borderRadius: t.radiusLg,
        border: `1px solid ${t.border}`, boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
        zIndex: ZIndex.sticky, minWidth: 220,
      }}
    >
      {/* 主题色 */}
      {themeColorMap.size > 0 && (
        <>
          <div style={{ fontSize: 11, color: t.textSecondary, marginBottom: 6, fontWeight: 500 }}>{translate('color.themeColors')}</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
            {THEME_COLOR_DEFS.map(({ key, label }) => {
              const hex = themeColorMap.get(key)
              if (!hex) return null
              const active = curThemeKey.toLowerCase() === key.toLowerCase()
              const isLight = hex.toUpperCase() === '#FFFFFF' || hex.toUpperCase() === '#FFF'
              return (
                <button
                  key={`theme-${key}`}
                  type="button"
                  title={translate(label)}
                  onClick={() => setThemeColor(key, hex)}
                  style={swatch(hex, true)}
                >
                  {active && (
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', fontSize: 11, fontWeight: 700, color: isLight ? '#000' : '#fff' }}>✓</span>
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}
      <div style={{ fontSize: 11, color: t.textSecondary, marginBottom: 6, fontWeight: 500 }}>{translate('color.textColors')}</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
        {TEXT_COLORS.map(({ name, color }) => (
          <button key={`tc-${name}`} type="button" title={translate(name)} onClick={() => setTextColor(color)} style={swatch(color, false)}>
            <span style={{ display: 'block', width: '100%', height: '100%', borderRadius: 3, background: color || 'linear-gradient(135deg,#e0e0e0 40%,#fff 40%,#fff 60%,#e0e0e0 60%)' }}>
              {color && editor.isActive('textStyle', { color }) && (
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', color: (color === '#FFFFFF' || color === '#FFF') ? '#000' : '#fff', fontSize: 11, fontWeight: 700 }}>✓</span>
              )}
            </span>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: t.textSecondary, marginBottom: 6, fontWeight: 500 }}>{translate('color.highlightColors')}</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {HIGHLIGHT_COLORS.map(({ name, color }) => (
          <button key={`hl-${name}`} type="button" title={translate(name)} onClick={() => setHighlight(color)} style={swatch(color, true)}>
            {color && editor.isActive('highlight', { color }) && (
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', fontSize: 11, fontWeight: 700, color: t.textPrimary }}>✓</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════
// 链接弹出面板
// ═══════════════════════════════════════════════

interface LinkPopoverProps {
  editor: Editor
  open: boolean
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
  translate: (key: string) => string
}

const LinkPopover: React.FC<LinkPopoverProps> = ({
  editor,
  open,
  onClose,
  anchorRef,
  translate,
}) => {
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 每次打开时，读取当前链接并填充输入框
  const currentHref = open ? (editor.getAttributes('link')?.href as string | undefined) : undefined
  const [inputValue, setInputValue] = useState('')

  useEffect(() => {
    if (open) {
      const defaultVal = currentHref?.startsWith('#page-')
        ? currentHref.slice(1)
        : (currentHref || '')
      setInputValue(defaultVal)
      // 延迟聚焦，等 DOM 渲染
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose, anchorRef])

  const applyLink = useCallback(() => {
    const value = inputValue.trim()
    if (!value) {
      // 清空 → 删除链接
      cmd(editor).unsetLink().run()
      onClose()
      return
    }
    const normalized = normalizeRichTextHyperlinkInput(value)
    if (!normalized) return // 无效输入不关闭，让用户修改
    const chain = cmd(editor).extendMarkRange('link').unsetLink()
    if (normalized.type === 'web') {
      chain.setLink({ href: normalized.href, target: '_blank', rel: 'noopener' })
    } else {
      chain.setLink({ href: normalized.href })
    }
    chain.run()
    onClose()
  }, [editor, inputValue, onClose])

  const removeLink = useCallback(() => {
    cmd(editor).unsetLink().run()
    onClose()
  }, [editor, onClose])

  if (!open) return null

  const hasLink = !!currentHref

  return (
    <div
      ref={panelRef}
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'absolute',
        top: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
        marginTop: 6,
        padding: '8px 10px',
        background: t.bgApp,
        border: `1px solid ${t.border}`,
        borderRadius: t.radiusLg,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        zIndex: ZIndex.sticky,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
        fontFamily: t.fontFamily,
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            applyLink()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
          e.stopPropagation()
        }}
        placeholder={translate('link.placeholder')}
        style={{
          width: 220,
          height: 28,
          padding: '0 8px',
          fontSize: 13,
          fontFamily: t.fontFamily,
          border: `1px solid ${t.border}`,
          borderRadius: t.radiusSm,
          outline: 'none',
          background: t.bgApp,
          color: t.textPrimary,
        }}
      />
      <button
        type="button"
        onClick={applyLink}
        style={{
          height: 28,
          padding: '0 10px',
          fontSize: 12,
          fontFamily: t.fontFamily,
          border: 'none',
          borderRadius: t.radiusSm,
          background: t.accent,
          color: t.accentForeground,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {translate('link.confirm')}
      </button>
      {hasLink && (
        <button
          type="button"
          onClick={removeLink}
          style={{
            height: 28,
            padding: '0 10px',
            fontSize: 12,
            fontFamily: t.fontFamily,
            border: `1px solid ${t.border}`,
            borderRadius: t.radiusSm,
            background: 'transparent',
            color: t.textSecondary,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {translate('link.remove')}
        </button>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════

interface TextBubbleMenuProps {
  editor: Editor
  isEditing: boolean
}

/**
 * TextBubbleMenu — PPT 文本浮动编辑工具栏
 *
 * 功能：
 * - 字体 / 字号 / 行高 / 字间距 下拉选择
 * - 加粗 / 斜体 / 下划线 / 删除线（含快捷键提示）
 * - 段落对齐（左 / 中 / 右）
 * - 文字颜色 & 背景高亮
 * - 无序列表 / 有序列表
 * - 缩进增减
 * - 上标 / 下标
 * - 边界保护（贴近视口顶部时自动翻到选区下方）
 * - 状态同步（每次 transaction 强制刷新按钮状态）
 */
const TextBubbleMenu: React.FC<TextBubbleMenuProps> = ({ editor, isEditing }) => {
  const translate = useT()
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [, syncTick] = useState(0) // 强制刷新按钮状态
  const [showColors, setShowColors] = useState(false)
  const colorBtnRef = useRef<HTMLButtonElement>(null)
  const [showLink, setShowLink] = useState(false)
  const linkBtnRef = useRef<HTMLButtonElement>(null)
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const toggleColors = useCallback(() => setShowColors((v) => !v), [])
  const toggleLink = useCallback(() => setShowLink((v) => !v), [])
  const closeLink = useCallback(() => setShowLink(false), [])

  // ── ⌘K 快捷键：监听自定义事件打开链接面板 ──
  useEffect(() => {
    if (!isEditing) return
    const handler = () => setShowLink(true)
    window.addEventListener('tabslide:open-link-popover', handler)
    return () => window.removeEventListener('tabslide:open-link-popover', handler)
  }, [isEditing])

  // ── 选区追踪 + 边界保护 ──
  useEffect(() => {
    if (!editor || !isEditing) {
      setPos(null)
      setShowColors(false)
      setShowLink(false)
      return
    }

    const update = () => {
      const { from, to } = editor.state.selection
      if (from === to) { setPos(null); return }

      try {
        const start = editor.view.coordsAtPos(from)
        const end = editor.view.coordsAtPos(to)
        const selTop = Math.min(start.top, end.top)
        const selBottom = Math.max(start.bottom, end.bottom)
        const centerX = (start.left + end.right) / 2

        // 边界保护：如果上方空间不足则翻到下方
        const aboveY = selTop - MENU_HEIGHT - MENU_GAP
        const placeAbove = aboveY >= FLIP_THRESHOLD
        const top = placeAbove ? aboveY : selBottom + MENU_GAP

        setPos({ top, left: centerX })
      } catch {
        setPos(null)
      }

      // 强制重渲染以同步按钮激活状态（如 Cmd+B 后 selection 不变但格式变了）
      syncTick((n) => n + 1)
    }

    // Delayed blur: when the editor loses focus (e.g. user clicks a toolbar
    // dropdown or switches to another pane), hide the toolbar after a short
    // delay. If the editor regains focus within the window (toolbar commands
    // call editor.chain().focus()), the timer is cancelled and the toolbar
    // stays visible.
    const handleBlur = () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
      blurTimerRef.current = setTimeout(() => {
        if (!editor.isFocused) {
          setPos(null)
        }
      }, 200)
    }

    const handleFocus = () => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current)
        blurTimerRef.current = undefined
      }
      update()
    }

    update()
    editor.on('selectionUpdate', update)
    editor.on('transaction', update)
    editor.on('focus', handleFocus)
    editor.on('blur', handleBlur)
    return () => {
      editor.off('selectionUpdate', update)
      editor.off('transaction', update)
      editor.off('focus', handleFocus)
      editor.off('blur', handleBlur)
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    }
  }, [editor, isEditing])

  // ── 系统字体列表（异步枚举，首次用降级方案） ──
  const fontItems = useSystemFonts(translate)

  // ── 读取当前格式状态 ──
  const textStyleAttrs = editor.getAttributes('textStyle')
  const paraAttrs = editor.getAttributes('paragraph')

  const curFontSize = (textStyleAttrs.fontSize as string) || ''
  const curFontFamily = (textStyleAttrs.fontFamily as string) || ''
  const curLineHeight = (paraAttrs.lineHeight as string) || ''
  const curLetterSpacing = (textStyleAttrs.letterSpacing as string) || ''

  const activeTextColor = TEXT_COLORS.find(({ color }) =>
    color && editor.isActive('textStyle', { color })
  )?.color || t.textPrimary

  // ── 格式命令 ──
  const setFontSize = useCallback((size: string) => {
    if (!size) {
      cmd(editor).setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run()
    } else {
      cmd(editor).setMark('textStyle', { fontSize: size }).run()
    }
  }, [editor])

  const setFontFamily = useCallback((family: string) => {
    if (!family) {
      cmd(editor).setMark('textStyle', { fontFamily: null }).removeEmptyTextStyle().run()
    } else {
      cmd(editor).setMark('textStyle', { fontFamily: family }).run()
    }
  }, [editor])

  const setLineHeight = useCallback((lh: string) => {
    cmd(editor).updateAttributes('paragraph', { lineHeight: lh || null }).run()
  }, [editor])

  const setLetterSpacing = useCallback((ls: string) => {
    if (!ls) {
      cmd(editor).setMark('textStyle', { letterSpacing: null }).removeEmptyTextStyle().run()
    } else {
      cmd(editor).setMark('textStyle', { letterSpacing: ls }).run()
    }
  }, [editor])

  if (!pos) return null

  const toolbar = (
    <div
      onMouseDown={(e) => { e.stopPropagation() }}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        transform: 'translateX(-50%)',
        zIndex: ZIndex.aboveGlobal,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '4px 5px',
        background: t.bgApp,
        borderRadius: t.radiusLg,
        border: `1px solid ${t.border}`,
        boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
        fontFamily: t.fontFamily,
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {/* ── 字体（运行时检测系统可用字体） ── */}
      <MiniDropdown
        value={curFontFamily}
        displayText={curFontFamily ? fontItems.find(f => f.value === curFontFamily)?.label || curFontFamily : translate('toolbar.font')}
        items={fontItems}
        onChange={setFontFamily}
        width={80}
        fontPreview
        title={translate('toolbar.font')}
      />

      {/* ── 字号 ── */}
      <MiniDropdown
        value={curFontSize}
        displayText={curFontSize ? curFontSize.replace(/(px|pt)$/i, '') : translate('toolbar.fontSize')}
        items={FONT_SIZES.map((s) => ({ label: s.replace(/(px|pt)$/i, ''), value: s }))}
        onChange={setFontSize}
        width={50}
        title={translate('toolbar.fontSize')}
      />

      <Divider />

      {/* ── 基础格式 ── */}
      <ToolBtn
        active={editor.isActive('bold')}
        onClick={() => cmd(editor).toggleBold().run()}
        title={`${translate('toolbar.bold')} (${MOD}B)`}
      >
        <BoldIcon />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('italic')}
        onClick={() => cmd(editor).toggleItalic().run()}
        title={`${translate('toolbar.italic')} (${MOD}I)`}
      >
        <ItalicIcon />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('underline')}
        onClick={() => cmd(editor).toggleUnderline().run()}
        title={`${translate('toolbar.underline')} (${MOD}U)`}
      >
        <UnderlineIcon />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('strike')}
        onClick={() => cmd(editor).toggleStrike().run()}
        title={`${translate('toolbar.strikethrough')} (${MOD}Shift+S)`}
      >
        <StrikeIcon />
      </ToolBtn>
      <div style={{ position: 'relative' }}>
        <ToolBtn
          ref={linkBtnRef}
          active={editor.isActive('link')}
          onClick={toggleLink}
          title={`${translate('toolbar.link')} (${MOD}K)`}
        >
          <LinkIcon />
        </ToolBtn>
        <LinkPopover editor={editor} open={showLink} onClose={closeLink} anchorRef={linkBtnRef} translate={translate} />
      </div>

      <Divider />

      {/* ── 段落对齐 ── */}
      <ToolBtn
        active={editor.isActive({ textAlign: 'left' })}
        onClick={() => cmd(editor).setTextAlign('left').run()}
        title={`${translate('toolbar.alignLeft')} (${MOD}Shift+L)`}
      >
        <AlignLeftIcon />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive({ textAlign: 'center' })}
        onClick={() => cmd(editor).setTextAlign('center').run()}
        title={`${translate('toolbar.alignCenter')} (${MOD}Shift+E)`}
      >
        <AlignCenterIcon />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive({ textAlign: 'right' })}
        onClick={() => cmd(editor).setTextAlign('right').run()}
        title={`${translate('toolbar.alignRight')} (${MOD}Shift+R)`}
      >
        <AlignRightIcon />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive({ textAlign: 'justify' })}
        onClick={() => cmd(editor).setTextAlign('justify').run()}
        title={`${translate('toolbar.alignJustify')} (${MOD}Shift+J)`}
      >
        <AlignJustifyIcon />
      </ToolBtn>

      <Divider />

      {/* ── 行高 ── */}
      <MiniDropdown
        value={curLineHeight}
        displayText={curLineHeight || undefined}
        items={LINE_HEIGHTS}
        onChange={setLineHeight}
        width={46}
        placeholder={translate('toolbar.lineHeight')}
        title={translate('toolbar.lineHeight')}
      />

      <Divider />

      {/* ── 颜色 ── */}
      <div style={{ position: 'relative' }}>
        <ToolBtn
          ref={colorBtnRef}
          onClick={toggleColors}
          title={translate('toolbar.fontColor')}
          style={{ gap: 2, width: 'auto', padding: '0 6px' }}
        >
          <span style={{
            fontWeight: 700, fontSize: 14,
            borderBottom: `2.5px solid ${activeTextColor}`,
            lineHeight: 1, paddingBottom: 1,
          }}>A</span>
          <ChevronDownIcon />
        </ToolBtn>
        <ColorPopover editor={editor} open={showColors} onToggle={toggleColors} anchorRef={colorBtnRef} translate={translate} />
      </div>

      <Divider />

      {/* ── 列表 ── */}
      <ToolBtn
        active={editor.isActive('bulletList')}
        onClick={() => cmd(editor).toggleBulletList().run()}
        title={translate('toolbar.bulletList')}
      >
        <BulletListIcon />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('orderedList')}
        onClick={() => cmd(editor).toggleOrderedList().run()}
        title={translate('toolbar.orderedList')}
      >
        <OrderedListIcon />
      </ToolBtn>

      <Divider />

      {/* ── 缩进 ── */}
      <ToolBtn
        onClick={() => {
          if (editor.isActive('bulletList') || editor.isActive('orderedList')) {
            cmd(editor).liftListItem('listItem').run()
          } else {
            const cur = editor.getAttributes('paragraph').paddingLeft as string || ''
            const px = parseInt(cur) || 0
            const next = Math.max(0, px - 24)
            cmd(editor).updateAttributes('paragraph', { paddingLeft: next > 0 ? `${next}px` : null }).run()
          }
        }}
        title={translate('toolbar.outdent')}
      >
        <OutdentIcon />
      </ToolBtn>
      <ToolBtn
        onClick={() => {
          if (editor.isActive('bulletList') || editor.isActive('orderedList')) {
            cmd(editor).sinkListItem('listItem').run()
          } else {
            const cur = editor.getAttributes('paragraph').paddingLeft as string || ''
            const px = parseInt(cur) || 0
            const next = px + 24
            cmd(editor).updateAttributes('paragraph', { paddingLeft: `${next}px` }).run()
          }
        }}
        title={translate('toolbar.indent')}
      >
        <IndentIcon />
      </ToolBtn>

      <Divider />

      {/* ── 上标 / 下标 ── */}
      <ToolBtn
        active={editor.isActive('superscript')}
        onClick={() => cmd(editor).toggleSuperscript().run()}
        title={translate('toolbar.superscript')}
      >
        <SuperscriptIcon />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('subscript')}
        onClick={() => cmd(editor).toggleSubscript().run()}
        title={translate('toolbar.subscript')}
      >
        <SubscriptIcon />
      </ToolBtn>

      <Divider />

      {/* ── 字间距 ── */}
      <MiniDropdown
        value={curLetterSpacing}
        displayText={curLetterSpacing ? curLetterSpacing.replace('px', '') : undefined}
        items={LETTER_SPACINGS.map(item => ({
          ...item,
          label: item.label.startsWith('letterSpacing.') ? translate(item.label) : item.label
        }))}
        onChange={setLetterSpacing}
        width={46}
        placeholder={translate('toolbar.letterSpacing')}
        title={translate('toolbar.letterSpacing')}
      />
    </div>
  )

  return createPortal(toolbar, document.body)
}

export default React.memo(TextBubbleMenu)
