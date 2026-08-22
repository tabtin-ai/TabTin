import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useSlideStore } from '../store/slide'
import { useT } from '../i18n'
import { Play, FileUp, Download, History, ChevronDown } from 'lucide-react'

export interface SlideTopBarProps {
  /** 放映回调；fromBeginning=true 从头放映，否则从当前页 */
  onStartShow?: (fromBeginning?: boolean) => void
  onImportPPTX?: () => void
  onExportPPTX?: () => void
  onExportPDF?: () => void
  onExportImages?: () => void
  onOpenVersionHistory?: () => void
}

type MenuItem = {
  key: string
  icon?: React.ReactNode
  label: string
  onClick: () => void
}

/** open 时监听点击外部 / Esc 自动关闭 */
function useDismiss(
  open: boolean,
  close: () => void,
  containerRef: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close()
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close, containerRef])
}

/** 顶栏下拉菜单面板 */
const MenuPanel: React.FC<{ items: MenuItem[]; onClose: () => void }> = ({ items, onClose }) => (
  <div className="absolute right-0 top-[calc(100%+4px)] z-dropdown min-w-[168px] rounded-md border border-border/40 bg-popover py-1 shadow-lg">
    {items.map((it) => (
      <button
        key={it.key}
        type="button"
        onClick={() => { it.onClick(); onClose() }}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-body text-foreground transition-colors hover:bg-muted"
      >
        {it.icon && (
          <span className="flex shrink-0 text-muted-foreground/70 [&_svg]:h-3.5 [&_svg]:w-3.5">{it.icon}</span>
        )}
        <span className="truncate">{it.label}</span>
      </button>
    ))}
  </div>
)

/** 顶栏下拉菜单：触发按钮 + 点击外部/Esc 关闭的下拉项 */
const TopBarMenu: React.FC<{
  label: string
  icon: React.ReactNode
  items: MenuItem[]
  primary?: boolean
}> = ({ label, icon, items, primary = false }) => {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, containerRef)

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={[
          'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-body font-medium transition-colors',
          primary
            ? 'bg-primary text-primary-foreground hover:bg-primary/85'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        ].join(' ')}
      >
        <span className="flex shrink-0 [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
        <span>{label}</span>
        <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
      </button>
      {open && <MenuPanel items={items} onClose={close} />}
    </div>
  )
}

/**
 * 分裂按钮（button group）：主体直接触发默认动作，右侧箭头才弹出菜单。
 */
const TopBarSplitButton: React.FC<{
  label: string
  icon: React.ReactNode
  onMainClick: () => void
  items: MenuItem[]
  caretLabel: string
  primary?: boolean
}> = ({ label, icon, onMainClick, items, caretLabel, primary = false }) => {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, containerRef)

  const segmentBase = 'flex h-7 items-center transition-colors'
  const skin = primary
    ? 'bg-primary text-primary-foreground hover:bg-primary/85'
    : 'bg-muted text-foreground hover:bg-muted/70'
  const dividerColor = primary ? 'bg-primary-foreground/25' : 'bg-border'

  return (
    <div ref={containerRef} className="relative inline-flex">
      <div className="inline-flex items-stretch overflow-hidden rounded-md">
        <button
          type="button"
          onClick={onMainClick}
          className={`${segmentBase} ${skin} gap-1.5 pl-2.5 pr-2 text-body font-medium [&_svg]:h-3.5 [&_svg]:w-3.5`}
        >
          <span className="flex shrink-0">{icon}</span>
          <span>{label}</span>
        </button>
        <span className={`w-px self-stretch ${dividerColor}`} aria-hidden />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={caretLabel}
          title={caretLabel}
          className={`${segmentBase} ${skin} px-1.5`}
        >
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>
      </div>
      {open && <MenuPanel items={items} onClose={close} />}
    </div>
  )
}

/** 顶栏纯图标按钮 */
const TopBarIconButton: React.FC<{
  label: string
  icon: React.ReactNode
  onClick: () => void
}> = ({ label, icon, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    title={label}
    aria-label={label}
    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:h-3.5 [&_svg]:w-3.5"
  >
    {icon}
  </button>
)

/** 顶栏带文字按钮 */
const TopBarButton: React.FC<{
  label: string
  icon: React.ReactNode
  onClick: () => void
}> = ({ label, icon, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-body font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:h-3.5 [&_svg]:w-3.5"
  >
    <span className="flex shrink-0">{icon}</span>
    <span>{label}</span>
  </button>
)

/**
 * SlideTitle — 可编辑演示文稿名 + 保存状态指示器。
 * 从 RightSidebar 上浮到顶栏左侧（对齐 TabVideo 顶栏的项目名）。
 */
const SlideTitle: React.FC = () => {
  const translate = useT()
  const presentation = useSlideStore((s) => s.presentation)
  const saveStatus = useSlideStore((s) => s.saveStatus)
  const saveError = useSlideStore((s) => s.saveError)
  const updatePresentationMeta = useSlideStore((s) => s.updatePresentationMeta)

  const name = presentation?.name || translate('untitled')
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEdit = useCallback(() => {
    if (!presentation) return
    setEditValue(name)
    setIsEditing(true)
  }, [name, presentation])

  const commitEdit = useCallback(() => {
    if (!presentation) { setIsEditing(false); return }
    const next = editValue.trim() || translate('untitled')
    if (next !== presentation.name) {
      updatePresentationMeta({ name: next })
    }
    setIsEditing(false)
  }, [editValue, presentation, updatePresentationMeta, translate])

  const cancelEdit = useCallback(() => {
    setEditValue(name)
    setIsEditing(false)
  }, [name])

  useEffect(() => {
    if (!isEditing) return
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [isEditing])

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); commitEdit() }
          else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
        }}
        className="min-w-0 max-w-[320px] flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-body font-semibold text-foreground outline-none focus:ring-1 focus:ring-ring"
      />
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        onClick={startEdit}
        className="cursor-text truncate rounded px-1.5 py-0.5 text-body font-semibold text-foreground transition-colors hover:bg-muted/80"
        title={translate('name.editHint') || name}
      >
        {name}
      </span>
      {saveStatus === 'saving' && (
        <span className="flex shrink-0 items-center gap-1 text-caption text-muted-foreground">
          <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
          </svg>
          {translate('message.saving')}
        </span>
      )}
      {saveStatus === 'saved' && (
        <span className="flex shrink-0 items-center gap-1 text-caption text-success dark:text-success">
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {translate('message.saved')}
        </span>
      )}
      {saveStatus === 'error' && (
        <span className="flex shrink-0 items-center gap-1 text-caption text-destructive" title={saveError ?? ''}>
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {translate('message.saveError')}
        </span>
      )}
      {saveStatus === 'unsaved' && (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-caption text-muted-foreground">
          {translate('message.editing')}
        </span>
      )}
    </div>
  )
}

/**
 * 演示模块顶栏（对齐 TabVideo EditorHeader）：
 * 左侧标题 + 保存态，右侧放映 / 导入 / 导出 / 版本历史。
 */
export const SlideTopBar: React.FC<SlideTopBarProps> = ({
  onStartShow,
  onImportPPTX,
  onExportPPTX,
  onExportPDF,
  onExportImages,
  onOpenVersionHistory,
}) => {
  const translate = useT()

  const exportItems: MenuItem[] = []
  if (onExportPPTX) {
    exportItems.push({ key: 'pptx', icon: <Download />, label: translate('export.pptx'), onClick: onExportPPTX })
  }
  if (onExportPDF) {
    exportItems.push({ key: 'pdf', icon: <Download />, label: translate('export.pdf'), onClick: onExportPDF })
  }
  if (onExportImages) {
    exportItems.push({ key: 'images', icon: <Download />, label: translate('export.images'), onClick: onExportImages })
  }

  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 bg-background px-3">
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        <SlideTitle />
      </div>

      <nav className="flex shrink-0 items-center gap-1.5">
        {onStartShow && (
          <TopBarSplitButton
            primary
            icon={<Play />}
            label={translate('present.title')}
            caretLabel={translate('present.title')}
            onMainClick={() => onStartShow(true)}
            items={[
              { key: 'from-beginning', icon: <Play />, label: translate('present.fromBeginning'), onClick: () => onStartShow(true) },
              { key: 'from-current', icon: <Play />, label: translate('present.fromCurrent'), onClick: () => onStartShow(false) },
            ]}
          />
        )}
        {onImportPPTX && (
          <TopBarButton label={translate('import.pptx')} icon={<FileUp />} onClick={onImportPPTX} />
        )}
        {exportItems.length > 0 && (
          <TopBarMenu icon={<Download />} label={translate('export.title')} items={exportItems} />
        )}
        {onOpenVersionHistory && (
          <TopBarIconButton label={translate('versionHistory')} icon={<History />} onClick={onOpenVersionHistory} />
        )}
      </nav>
    </header>
  )
}

export default SlideTopBar
