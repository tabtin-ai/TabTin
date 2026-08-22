/**
 * 代码选区浮动操作条（代码选区浮动操作条）
 *
 * 锚定在 Monaco 选区上方；材质走 OVERLAY_SURFACE_CLASS（不透明浮层）。
 * 当前仅「添加到对话」——产品侧暂无行内 Quick Edit，避免假按钮。
 */

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { MessageSquarePlus } from 'lucide-react'
import { cn, OVERLAY_SURFACE_CLASS } from '@components/ui'
import {
  CODE_SELECTION_TOOLBAR_HEIGHT,
  resolveCodeSelectionToolbarPosition,
  type CodeSelectionData,
} from './codeSelection'

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent)

function modKey(key: string, withShift = false): string {
  if (IS_MAC) return withShift ? `⇧⌘${key}` : `⌘${key}`
  return withShift ? `Ctrl+Shift+${key}` : `Ctrl+${key}`
}

export interface CodeSelectionToolbarProps {
  selection: CodeSelectionData | null
  onAddToChat: (selection: CodeSelectionData) => void
  /** 测试或非浏览器环境可注入挂载点 */
  portalRoot?: HTMLElement | null
}

export const CodeSelectionToolbar: React.FC<CodeSelectionToolbarProps> = ({
  selection,
  onAddToChat,
  portalRoot,
}) => {
  const { t } = useTranslation('tabcode')
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [toolbarWidth, setToolbarWidth] = useState(200)

  const visible = Boolean(selection?.text && selection.anchor)

  useLayoutEffect(() => {
    if (!visible || !toolbarRef.current) return
    setToolbarWidth(toolbarRef.current.getBoundingClientRect().width || 200)
  }, [visible, selection?.text])

  const position = useMemo(() => {
    if (!selection?.anchor) return null
    return resolveCodeSelectionToolbarPosition(selection.anchor, { toolbarWidth })
  }, [selection?.anchor, toolbarWidth])

  if (!visible || !selection || !position) return null

  const root = portalRoot ?? (typeof document !== 'undefined' ? document.body : null)
  if (!root) return null

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={t('preview.selectionToolbarLabel', '选区操作')}
      className={cn(
        'fixed z-dropdown flex h-9 items-center gap-0.5 rounded-lg px-1',
        OVERLAY_SURFACE_CLASS,
      )}
      style={{
        top: position.top,
        left: position.left,
        transform: 'translateX(-50%)',
        minHeight: CODE_SELECTION_TOOLBAR_HEIGHT,
      }}
      onMouseDown={(event) => {
        // 避免点击工具条时 Monaco 失焦并清掉选区
        event.preventDefault()
      }}
    >
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-caption text-foreground/90 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        onClick={() => onAddToChat(selection)}
      >
        <span className="text-muted-foreground/60">
          <MessageSquarePlus className="h-3.5 w-3.5" />
        </span>
        <span className="whitespace-nowrap font-medium">
          {t('preview.addToChat', '添加到对话')}
        </span>
        <kbd className="ml-0.5 rounded bg-foreground/[0.06] px-1 py-px text-caption tabular-nums text-muted-foreground/60">
          {modKey('L', true)}
        </kbd>
      </button>
    </div>,
    root,
  )
}

CodeSelectionToolbar.displayName = 'CodeSelectionToolbar'
export default CodeSelectionToolbar
