import { useEffect } from 'react'
import { useSlideStore, resolveMovableLayerIds } from '../store/slide'
import { useHistoryStore } from '../store/history'
import { useClipboard, hasInternalClipboard } from './useClipboard'
import { keymapManager, KeyboardPriority } from '../utils/keymap-manager'
import type { PPTElement, Slide } from '../types/slides'

/**
 * 全局键盘快捷键
 *
 * 完整快捷键列表：
 *
 * | 快捷键              | 功能           |
 * |---------------------|----------------|
 * | Delete / Backspace  | 删除选中       |
 * | Escape              | 退出编辑/取消选 |
 * | Ctrl+A              | 全选           |
 * | Ctrl+C              | 复制           |
 * | Ctrl+X              | 剪切           |
 * | Ctrl+V              | 粘贴           |
 * | Ctrl+D              | 快速复制       |
 * | Ctrl+]              | 上移一层       |
 * | Ctrl+[              | 下移一层       |
 * | Ctrl+Shift+]        | 置顶           |
 * | Ctrl+Shift+[        | 置底           |
 * | Ctrl+Z              | 撤销           |
 * | Ctrl+Shift+Z / Ctrl+Y | 重做        |
 * | Ctrl+Enter           | 在当前页后新建页 |
 * | Arrow Keys          | 微移 1px       |
 * | Shift + Arrow Keys  | 微移 10px      |
 */
export interface UseKeyboardOptions {
  tryPasteClipboardImage?: () => Promise<boolean>
  tryPasteClipboardText?: () => Promise<boolean>
}

type SlideState = ReturnType<typeof useSlideStore.getState>

/**
 * 编辑态防冲突 guard：编辑器（Tiptap / Shape 文字 / 表格单元格 / HTML 编辑器）或
 * 侧边栏输入框聚焦时，除 undo/redo 外的快捷键必须留给编辑器处理。
 */
export function shouldBypassGlobalKeyboard(
  e: KeyboardEvent,
  isEditing: boolean,
  isUndoRedo: boolean,
): boolean {
  // 编辑状态下基于 store 状态判断，是最可靠的防线
  if (isEditing && !isUndoRedo) return true
  // 焦点在侧边栏 INPUT / TEXTAREA / contentEditable 时同样跳过
  const target = e.target as HTMLElement | null
  const tag = target?.tagName
  if (!isUndoRedo && (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable)) return true
  return false
}

export function useKeyboard(options: UseKeyboardOptions = {}) {
  const { tryPasteClipboardImage, tryPasteClipboardText } = options
  const store = useSlideStore
  const { copy, cut, paste, quickDuplicate } = useClipboard()

  useEffect(() => {
    // 箭头键微移 debounce：连续按箭头时只在开头推一次快照，
    // 300ms 内无新按键后重置，下次再推。与 PPTist/Figma 体验一致。
    let arrowSnapshotPushed = false
    let arrowDebounceTimer: ReturnType<typeof setTimeout> | null = null

    // H2-02: 使用 store action 统一历史恢复入口，
    // 走 normalizeElementTransform 保持元素坐标规范化一致性，
    // 并重置 version（H2-12）防止 CAS 乐观锁版本错误。
    const applyHistoryPages = (pages: Slide[]) => {
      store.getState().applyHistoryPages(pages)
    }

    // Ctrl+Z / Ctrl+Y：撤销 / 重做。编辑态下先 flush 当前编辑内容再读 fresh state。
    const navigateHistory = (s: SlideState, isRedo: boolean) => {
      if (!s.presentation) return
      if (s.isEditing) {
        window.dispatchEvent(new CustomEvent('tabslide:flush-text-edit'))
        const fresh = store.getState()
        if (!fresh.presentation) return
        const pages = isRedo
          ? useHistoryStore.getState().redo(fresh.presentation.pages)
          : useHistoryStore.getState().undo(fresh.presentation.pages)
        if (pages) applyHistoryPages(pages)
      } else {
        const pages = isRedo
          ? useHistoryStore.getState().redo(s.presentation.pages)
          : useHistoryStore.getState().undo(s.presentation.pages)
        if (pages) applyHistoryPages(pages)
      }
    }

    const deleteSelection = (s: SlideState) => {
      if (s.selectedElementIds.length === 0) return
      const page = s.currentPage()
      if (!page) return
      const selectedSet = new Set(s.selectedElementIds)
      const deletableIds = page.elements
        .filter((el) => selectedSet.has(el.id) && !el.locked)
        .map((el) => el.id)
      if (deletableIds.length === 0) return
      if (s.presentation) useHistoryStore.getState().pushSnapshot(s.presentation.pages)
      s.deleteElements(deletableIds)
    }

    const pasteFromClipboard = () => {
      if (hasInternalClipboard()) {
        paste()
        return
      }
      if (!tryPasteClipboardImage && !tryPasteClipboardText) return
      // 回退链：图片 → 富文本/纯文本
      const tryImage = tryPasteClipboardImage
        ? tryPasteClipboardImage()
        : Promise.resolve(false)
      tryImage.then((handled) => {
        if (handled) return
        if (tryPasteClipboardText) {
          return tryPasteClipboardText()
        }
      }).catch((err) => {
        console.warn('[useKeyboard] clipboard paste failed:', err)
      })
    }

    const groupShortcut = (s: SlideState, shift: boolean) => {
      const canRun = shift
        ? s.selectedElementIds.length > 0
        : s.selectedElementIds.length >= 2
      if (!canRun) return
      if (s.presentation) useHistoryStore.getState().pushSnapshot(s.presentation.pages)
      if (shift) {
        // Cmd+Shift+G：取消组合
        if (s.selectedElementIds.length > 0) {
          s.ungroupElements(s.selectedElementIds)
        }
      } else {
        // Cmd+G：组合
        if (s.selectedElementIds.length >= 2) {
          s.groupElements(s.selectedElementIds)
        }
      }
    }

    const reorderLayer = (s: SlideState, forward: boolean, shift: boolean) => {
      if (s.selectedElementIds.length === 0) return
      if (s.presentation) useHistoryStore.getState().pushSnapshot(s.presentation.pages)
      if (forward) {
        if (shift) s.bringSelectionToFront(s.selectedElementIds)
        else s.bringForwardSelection(s.selectedElementIds)
      } else {
        if (shift) s.sendSelectionToBack(s.selectedElementIds)
        else s.sendBackwardSelection(s.selectedElementIds)
      }
    }

    const nudgeSelection = (s: SlideState, key: string, shift: boolean) => {
      if (s.selectedElementIds.length === 0) return
      const delta = shift ? 10 : 1
      const dx = key === 'ArrowLeft' ? -delta : key === 'ArrowRight' ? delta : 0
      const dy = key === 'ArrowUp' ? -delta : key === 'ArrowDown' ? delta : 0

      const page = s.currentPage()
      if (!page) return

      // P1-2: 使用 resolveMovableLayerIds 处理组合语义 —
      // 组合中任一成员锁定则整组不可移动，避免拆散组合
      const movableIds = resolveMovableLayerIds(page.elements, s.selectedElementIds)
      if (movableIds.length === 0) return

      // 只在连续箭头键的第一次推快照，后续 300ms 内不再推
      if (!arrowSnapshotPushed && s.presentation) {
        useHistoryStore.getState().pushSnapshot(s.presentation.pages)
        arrowSnapshotPushed = true
      }
      if (arrowDebounceTimer) clearTimeout(arrowDebounceTimer)
      arrowDebounceTimer = setTimeout(() => {
        arrowSnapshotPushed = false
        arrowDebounceTimer = null
      }, 300)

      // P2-1: 批量 updateElements 代替逐个 updateElement，单次 store 更新
      const batchUpdates: Array<{ id: string; updates: Partial<PPTElement> }> = []
      for (const id of movableIds) {
        const el = page.elements.find((item) => item.id === id)
        if (!el) continue
        batchUpdates.push({
          id,
          updates: { x: el.x + dx, y: el.y + dy } as Partial<PPTElement>,
        })
      }
      if (batchUpdates.length > 0) {
        s.updateElements(batchUpdates)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return

      const s = store.getState()
      const isMod = e.ctrlKey || e.metaKey

      // ── Escape 退出编辑模式（最高优先级） ──
      if (e.key === 'Escape' && s.isEditing) {
        e.preventDefault()
        s.setEditing(null)
        return
      }

      // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 在文本编辑中也走全局 undo/redo
      // （Tiptap History 已禁用，全局 store 统一管理撤销历史）
      const isUndoRedo = isMod && (
        e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y'
      )

      if (shouldBypassGlobalKeyboard(e, s.isEditing, isUndoRedo)) return

      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          if (s.selectedElementIds.length > 0) {
            e.preventDefault()
            deleteSelection(s)
          }
          break

        case 'Escape':
          s.clearSelection()
          break

        case 'a':
        case 'A':
          if (isMod) {
            e.preventDefault()
            s.selectAll()
          }
          break

        case 'c':
        case 'C':
          if (isMod) {
            e.preventDefault()
            copy()
          }
          break

        case 'x':
        case 'X':
          if (isMod) {
            e.preventDefault()
            cut()
          }
          break

        case 'v':
        case 'V':
          if (isMod) {
            e.preventDefault()
            pasteFromClipboard()
          }
          break

        case 'd':
        case 'D':
          if (isMod) {
            e.preventDefault()
            quickDuplicate()
          }
          break

        case 'g':
        case 'G':
          if (isMod) {
            e.preventDefault()
            groupShortcut(s, e.shiftKey)
          }
          break

        case ']':
          if (isMod && s.selectedElementIds.length > 0) {
            e.preventDefault()
            reorderLayer(s, true, e.shiftKey)
          }
          break

        case '[':
          if (isMod && s.selectedElementIds.length > 0) {
            e.preventDefault()
            reorderLayer(s, false, e.shiftKey)
          }
          break

        case 'z':
        case 'Z':
          if (isMod) {
            e.preventDefault()
            navigateHistory(s, e.shiftKey)
          }
          break

        case 'y':
        case 'Y':
          if (isMod) {
            e.preventDefault()
            navigateHistory(s, true)
          }
          break

        case 'Enter':
          if (isMod && !e.shiftKey) {
            e.preventDefault()
            if (!s.presentation) break
            useHistoryStore.getState().pushSnapshot(s.presentation.pages)
            s.addPage(s.currentPageIndex)
          }
          break

        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (s.selectedElementIds.length === 0) break
          e.preventDefault()
          nudgeSelection(s, e.key, e.shiftKey)
          break
        }
      }
    }

    const unregister = keymapManager.register(KeyboardPriority.GLOBAL, handleKeyDown)
    return () => {
      unregister()
      if (arrowDebounceTimer) clearTimeout(arrowDebounceTimer)
    }
  }, [copy, cut, paste, quickDuplicate, tryPasteClipboardImage, tryPasteClipboardText])
}
