import { useCallback, useEffect, useRef } from 'react'
import type { ContextItem } from '@components/context-space/registry'
import {
  getNumericTabAction,
  isContextSpaceSwitchTabAction,
  resolveSwitchTabIndex,
  type ContextSpaceShortcutAction,
} from '@shared/context-space-shortcuts'

interface UseContextSpaceShortcutsOptions {
  enabled?: boolean
  activeTabKey: string | null
  orderedTabKeys: string[]
  /**
   * 用户肉眼可见的 tab 条顺序（不含 canvas group 内的子 pane）。
   * ⌘1..⌘8 / ⌘9 数字键切换基于此列表：
   * - ⌘N → visibleTabKeys[N-1]（N=1..8），不足时静默
   * - ⌘9 → visibleTabKeys[last]（Chrome / Arc / VSCode 惯例）
   */
  visibleTabKeys: string[]
  itemsByTabKey: Map<string, ContextItem>
  onSelectItem: (item: ContextItem) => void
  onCloseItem: (item: ContextItem) => void
  onRefreshItem: (item: ContextItem) => void
  onCreateWebTab?: () => void
  onBackItem?: (item: ContextItem) => void
  onForwardItem?: (item: ContextItem) => void
  onFindItem?: (item: ContextItem) => void
  onZoomItem?: (item: ContextItem, direction: 'in' | 'out' | 'reset') => void
  onFocusUrl?: () => void
  onReopenClosedTab?: () => void
}

const resolveActiveItem = (activeTabKey: string | null, itemsByTabKey: Map<string, ContextItem>) => {
  if (!activeTabKey) return null
  return itemsByTabKey.get(activeTabKey) ?? null
}

/**
 * useContextSpaceShortcuts - 快捷键处理 Hook
 *
 * ⚠️ 重要设计决策：
 * - 使用 useRef 存储 handleAction，避免 IPC 监听器频繁重新注册
 * - IPC 监听器只在 enabled 变化时注册/移除
 * - 这解决了 "MaxListenersExceededWarning" 问题
 */
export const useContextSpaceShortcuts = ({
  enabled = true,
  activeTabKey,
  orderedTabKeys,
  visibleTabKeys,
  itemsByTabKey,
  onSelectItem,
  onCloseItem,
  onRefreshItem,
  onCreateWebTab,
  onBackItem,
  onForwardItem,
  onFindItem,
  onZoomItem,
  onFocusUrl,
  onReopenClosedTab
}: UseContextSpaceShortcutsOptions) => {
  const switchTab = useCallback((direction: 1 | -1) => {
    if (orderedTabKeys.length === 0) return
    if (orderedTabKeys.length === 1 && activeTabKey) return

    const currentIndex = activeTabKey ? orderedTabKeys.indexOf(activeTabKey) : -1
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : orderedTabKeys.length - 1
        : (currentIndex + direction + orderedTabKeys.length) % orderedTabKeys.length
    const nextKey = orderedTabKeys[nextIndex]
    const nextItem = itemsByTabKey.get(nextKey)
    if (!nextItem) return
    onSelectItem(nextItem)
  }, [activeTabKey, itemsByTabKey, onSelectItem, orderedTabKeys])

  const handleAction = useCallback((action: ContextSpaceShortcutAction) => {
    if (action === 'new-tab') {
      onCreateWebTab?.()
      return
    }

    if (action === 'reopen-closed-tab') {
      onReopenClosedTab?.()
      return
    }

    if (action === 'next-tab') {
      switchTab(1)
      return
    }

    if (action === 'prev-tab') {
      switchTab(-1)
      return
    }

    if (action === 'focus-url') {
      onFocusUrl?.()
      return
    }

    if (isContextSpaceSwitchTabAction(action)) {
      const index = resolveSwitchTabIndex(action, visibleTabKeys.length)
      if (index === null) return
      const targetKey = visibleTabKeys[index]
      if (!targetKey) return
      const targetItem = itemsByTabKey.get(targetKey)
      if (!targetItem) return
      onSelectItem(targetItem)
      return
    }

    const activeItem = resolveActiveItem(activeTabKey, itemsByTabKey)
    if (!activeItem) return

    if (action === 'refresh') {
      onRefreshItem(activeItem)
      return
    }

    if (action === 'close') {
      onCloseItem(activeItem)
      return
    }

    if (action === 'back') {
      onBackItem?.(activeItem)
      return
    }

    if (action === 'forward') {
      onForwardItem?.(activeItem)
      return
    }

    if (action === 'find') {
      onFindItem?.(activeItem)
      return
    }

    if (action === 'zoom-in') {
      onZoomItem?.(activeItem, 'in')
      return
    }

    if (action === 'zoom-out') {
      onZoomItem?.(activeItem, 'out')
      return
    }

    if (action === 'zoom-reset') {
      onZoomItem?.(activeItem, 'reset')
      return
    }
  }, [
    activeTabKey,
    itemsByTabKey,
    onCloseItem,
    onCreateWebTab,
    onRefreshItem,
    switchTab,
    onBackItem,
    onForwardItem,
    onFindItem,
    onZoomItem,
    onFocusUrl,
    onReopenClosedTab,
    visibleTabKeys,
    onSelectItem,
  ])

  // ⭐ 使用 ref 存储最新的 handleAction，避免监听器重新注册
  const handleActionRef = useRef(handleAction)
  handleActionRef.current = handleAction

  // DOM keydown 监听器
  useEffect(() => {
    if (!enabled) return
    // Electron 主进程已通过 before-input-event 转发快捷键，
    // 渲染进程避免重复处理导致双触发
    const hasElectronShortcutBridge = Boolean(window.electron?.ipcRenderer?.on)
    if (hasElectronShortcutBridge) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.isComposing) return

      const key = event.key.toLowerCase()
      const hasPrimaryModifier = event.metaKey || event.ctrlKey
      const isSafeModifierCombo = hasPrimaryModifier && !event.altKey

      if (isSafeModifierCombo && !event.shiftKey) {
        if (key === 'r') {
          event.preventDefault()
          handleActionRef.current('refresh')
          return
        }
        if (key === 'w') {
          event.preventDefault()
          handleActionRef.current('close')
          return
        }
        if (key === 't') {
          event.preventDefault()
          handleActionRef.current('new-tab')
          return
        }
        if (key === '[') {
          event.preventDefault()
          handleActionRef.current('back')
          return
        }
        if (key === ']') {
          event.preventDefault()
          handleActionRef.current('forward')
          return
        }
        if (key === 'f') {
          event.preventDefault()
          handleActionRef.current('find')
          return
        }
        if (key === 'l') {
          event.preventDefault()
          handleActionRef.current('focus-url')
          return
        }
        if (key === '=' || key === '+') {
          event.preventDefault()
          handleActionRef.current('zoom-in')
          return
        }
        if (key === '-') {
          event.preventDefault()
          handleActionRef.current('zoom-out')
          return
        }
        if (key === '0') {
          event.preventDefault()
          handleActionRef.current('zoom-reset')
          return
        }
        const numericAction = getNumericTabAction(key)
        if (numericAction) {
          event.preventDefault()
          handleActionRef.current(numericAction)
          return
        }
      }

      if (isSafeModifierCombo && event.shiftKey && key === 't') {
        event.preventDefault()
        handleActionRef.current('reopen-closed-tab')
        return
      }

      if (isSafeModifierCombo && event.shiftKey && (key === '=' || key === '+')) {
        event.preventDefault()
        handleActionRef.current('zoom-in')
        return
      }

      if (key === 'f5' && !hasPrimaryModifier && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        handleActionRef.current('refresh')
        return
      }

      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        handleActionRef.current(event.shiftKey ? 'prev-tab' : 'next-tab')
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [enabled]) // ⭐ 只依赖 enabled，不依赖 handleAction

  // IPC 监听器 - 只在 enabled 变化时注册/移除
  useEffect(() => {
    if (!enabled) return
    const ipcRenderer = window.electron?.ipcRenderer
    if (!ipcRenderer?.on) return

    const handleShortcut = (_event: unknown, payload: { action?: ContextSpaceShortcutAction }) => {
      if (!payload || !payload.action) return
      handleActionRef.current(payload.action) // ⭐ 使用 ref，避免闭包捕获旧值
    }

    const unsub = ipcRenderer.on('context-space:shortcut', handleShortcut)
    return () => {
      unsub?.()
    }
  }, [enabled]) // ⭐ 只依赖 enabled，监听器只注册一次
}
