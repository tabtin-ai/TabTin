/**
 * TerminalContextMenu - 终端右键上下文菜单
 *
 * 提供复制/粘贴/搜索/清除/分屏/均分/最大化/关闭等操作入口。
 * 使用 smartsheet-ui 的 ContextMenu 组件。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuDivider,
} from '@tabtin/smartsheet-ui'
import {
  Copy,
  ClipboardPaste,
  Search,
  ArrowDownToLine,
  Eraser,
  Columns2,
  Rows2,
  LayoutGrid,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  getTerminalSelection,
  clearTerminalBuffer,
  scrollTerminalToBottom,
  focusTerminalSession,
  pasteToTerminal,
} from './terminalRuntime'
import { useTerminalSplitStore } from '@stores/useTerminalSplitStore'
import { createSplitPane, closeSplitPane } from './terminalSplitActions'

const IS_MAC =
  typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')
const MOD = IS_MAC ? '⌘' : 'Ctrl+'

interface TerminalContextMenuState {
  open: boolean
  anchorPosition?: { x: number; y: number }
}

const MAX_TERMINAL_PANES = 6

export interface TerminalContextMenuProps {
  /** 当前 pane 的 sessionId（PTY session） */
  sessionId: string
  /** pane ID（用于 split store 操作），单 pane 时可省略 */
  paneId?: string
  /** 根 session ID */
  rootSessionId: string
  /** space ID */
  spaceId: string
  /** 当前 tab 下的 pane 总数 */
  paneCount: number
  /** 是否处于最大化状态 */
  isMaximized: boolean
  /** 触发搜索的回调（由对话 A 的 TerminalSearch 提供） */
  onSearch?: () => void
  children: React.ReactNode
}

export const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  sessionId,
  paneId,
  rootSessionId,
  spaceId,
  paneCount,
  isMaximized,
  onSearch,
  children,
}) => {
  const { t } = useTranslation('terminal')
  const [menu, setMenu] = useState<TerminalContextMenuState>({ open: false })
  const wrapperRef = useRef<HTMLDivElement>(null)

  // 使用原生 DOM 事件而非 React onContextMenu —— 终端内容通过 createPortal
  // 渲染在 TerminalPanePortalLayer 中，React 合成事件按 fiber 树冒泡，
  // 不会到达 DOM 祖先上的 React handler。原生事件按 DOM 树冒泡，可以正确捕获。
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const handler = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setMenu({ open: true, anchorPosition: { x: e.clientX, y: e.clientY } })
    }
    el.addEventListener('contextmenu', handler)
    return () => el.removeEventListener('contextmenu', handler)
  }, [])

  const handleClose = useCallback(() => {
    setMenu({ open: false })
    requestAnimationFrame(() => focusTerminalSession(sessionId))
  }, [sessionId])

  // ── 菜单操作 ──

  const handleCopy = useCallback(() => {
    const selection = getTerminalSelection(sessionId)
    if (!selection) return
    const trimmed = selection
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
    void navigator.clipboard.writeText(trimmed)
  }, [sessionId])

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        await pasteToTerminal(sessionId, text)
      }
    } catch {
      // clipboard read permission denied
    }
  }, [sessionId])

  const handleClear = useCallback(() => {
    clearTerminalBuffer(sessionId)
  }, [sessionId])

  const handleScrollToBottom = useCallback(() => {
    scrollTerminalToBottom(sessionId)
  }, [sessionId])

  const handleSplit = useCallback(
    (direction: 'horizontal' | 'vertical', side: 'right' | 'bottom') => {
      const targetPaneId = paneId || useTerminalSplitStore.getState().layouts[rootSessionId]?.activePaneId
      if (!targetPaneId) return
      // 统一走 createSplitPane：sessionId 不内嵌桶 key（防 scope 桶冒号污染快照名），
      // 且继承父 pane 的 cwd + executionSpaceId（保证分屏 PTY 与 root 同 working_dir /
      // 同 TABTIN_SPACE_ID）。spaceId 此处为 TerminalSplitContainer 跨桶解析出的桶 key。
      createSplitPane({
        rootSessionId,
        targetPaneId,
        direction,
        side,
        spaceId,
        defaultTitle: t('title'),
        inheritFromSessionId: sessionId,
      })
    },
    [paneId, rootSessionId, spaceId, sessionId, t],
  )

  const handleEqualize = useCallback(() => {
    useTerminalSplitStore.getState().equalizeAllSizes(rootSessionId)
  }, [rootSessionId])

  const handleToggleMaximize = useCallback(() => {
    const target = paneId || useTerminalSplitStore.getState().layouts[rootSessionId]?.activePaneId
    if (!target) return
    useTerminalSplitStore.getState().toggleMaximize(rootSessionId, target)
  }, [paneId, rootSessionId])

  const handleClosePane = useCallback(() => {
    const target = paneId || useTerminalSplitStore.getState().layouts[rootSessionId]?.activePaneId
    if (!target) return
    const layout = useTerminalSplitStore.getState().layouts[rootSessionId]
    const pane = layout?.panes[target]
    if (!pane) return
    closeSplitPane({
      rootSessionId,
      paneId: target,
      sessionId: pane.sessionId,
      spaceId,
    })
  }, [paneId, rootSessionId, spaceId])

  const hasSelection = useMemo(() => {
    if (!menu.open) return false
    return !!getTerminalSelection(sessionId)
  }, [menu.open, sessionId])

  const isMultiPane = paneCount > 1
  const canSplit = paneCount < MAX_TERMINAL_PANES
  const menuOpen = menu.open && !!menu.anchorPosition

  return (
    <>
      <div ref={wrapperRef} className="h-full w-full min-h-0 min-w-0">
        {children}
      </div>
      {menuOpen && (
        <ContextMenu
          open
          onClose={handleClose}
          anchorPosition={menu.anchorPosition}
          className="w-56"
        >
        {/* 剪贴板 */}
        <ContextMenuItem
          icon={<Copy className="h-4 w-4" />}
          label={t('contextMenu.copy')}
          shortcut={`${MOD}C`}
          onClick={handleCopy}
          disabled={!hasSelection}
        />
        <ContextMenuItem
          icon={<ClipboardPaste className="h-4 w-4" />}
          label={t('contextMenu.paste')}
          shortcut={`${MOD}V`}
          onClick={() => void handlePaste()}
        />

        <ContextMenuDivider />

        {/* 视图操作 */}
        <ContextMenuItem
          icon={<Search className="h-4 w-4" />}
          label={t('contextMenu.search')}
          shortcut={`${MOD}F`}
          onClick={onSearch}
          disabled={!onSearch}
        />
        <ContextMenuItem
          icon={<ArrowDownToLine className="h-4 w-4" />}
          label={t('contextMenu.scrollToBottom')}
          onClick={handleScrollToBottom}
        />
        <ContextMenuItem
          icon={<Eraser className="h-4 w-4" />}
          label={t('contextMenu.clear')}
          shortcut={`${MOD}K`}
          onClick={handleClear}
        />

        <ContextMenuDivider />

        {/* 分屏操作 */}
        {!isMaximized && (
          <ContextMenuItem
            icon={<Columns2 className="h-4 w-4" />}
            label={t('contextMenu.splitRight')}
            shortcut={`${MOD}D`}
            onClick={() => handleSplit('horizontal', 'right')}
            disabled={!canSplit}
          />
        )}
        {!isMaximized && (
          <ContextMenuItem
            icon={<Rows2 className="h-4 w-4" />}
            label={t('contextMenu.splitDown')}
            shortcut={`${MOD}⇧D`}
            onClick={() => handleSplit('vertical', 'bottom')}
            disabled={!canSplit}
          />
        )}
        {isMultiPane && !isMaximized && (
          <ContextMenuItem
            icon={<LayoutGrid className="h-4 w-4" />}
            label={t('contextMenu.equalize')}
            onClick={handleEqualize}
          />
        )}

        {isMultiPane && <ContextMenuDivider />}

        {/* 面板操作 */}
        {isMultiPane && (
          <ContextMenuItem
            icon={
              isMaximized ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )
            }
            label={isMaximized ? t('contextMenu.restore') : t('contextMenu.maximize')}
            onClick={handleToggleMaximize}
          />
        )}
        {isMultiPane && (
          <ContextMenuItem
            icon={<X className="h-4 w-4" />}
            label={t('contextMenu.close')}
            shortcut={`${MOD}⇧W`}
            onClick={handleClosePane}
            danger
          />
        )}
        </ContextMenu>
      )}
    </>
  )
}

TerminalContextMenu.displayName = 'TerminalContextMenu'
