import { useCallback } from 'react'
import { useSlideStore } from '../store/slide'
import { useHistoryStore } from '../store/history'
import { useClipboardStore } from '../store/clipboard'
import { createElementId, regenerateNestedIds } from '../utils/id'
import type { PPTElement } from '../types/slides'

/**
 * 剪切板（复制/粘贴/剪切）
 *
 * 参考 PPTist useCopyAndPasteElement.ts
 *
 * 设计决策：
 * - 使用 Zustand store 管理剪贴板状态（响应式，ContextMenu 等组件可实时订阅）
 * - structuredClone 深拷贝元素
 * - 粘贴时自动偏移 20px 避免重叠
 * - 支持跨页粘贴
 * - 保持组合关系（groupId 映射到新 ID）
 */

/** 检查内存剪贴板是否有已复制的元素（可在异步回调中安全调用） */
export function hasInternalClipboard(): boolean {
  return useClipboardStore.getState().items.length > 0
}

export function useClipboard() {
  const hasClipboard = useClipboardStore((s) => s.items.length > 0)

  const getMovableSelectedIds = useCallback((): string[] => {
    const s = useSlideStore.getState()
    const page = s.currentPage()
    if (!page || s.selectedElementIds.length === 0) return []
    const selectedSet = new Set(s.selectedElementIds)
    return page.elements
      .filter((el) => selectedSet.has(el.id) && !el.locked)
      .map((el) => el.id)
  }, [])

  const copy = useCallback(() => {
    const s = useSlideStore.getState()
    const page = s.currentPage()
    if (!page || s.selectedElementIds.length === 0) return

    const ids = new Set(s.selectedElementIds)
    const elements = page.elements.filter((el) => ids.has(el.id))
    if (elements.length === 0) return
    useClipboardStore.getState().setItems(structuredClone(elements))
  }, [])

  const cut = useCallback(() => {
    const s = useSlideStore.getState()
    const page = s.currentPage()
    if (!page || s.selectedElementIds.length === 0) return

    const cutIds = getMovableSelectedIds()
    if (cutIds.length === 0) return

    useHistoryStore.getState().pushSnapshot(s.presentation!.pages)

    const ids = new Set(cutIds)
    const elements = page.elements.filter((el) => ids.has(el.id))
    useClipboardStore.getState().setItems(structuredClone(elements), true)

    s.deleteElements(cutIds)
  }, [getMovableSelectedIds])

  const paste = useCallback(() => {
    const clipState = useClipboardStore.getState()
    if (clipState.items.length === 0) return

    const s = useSlideStore.getState()
    if (!s.presentation) return

    useHistoryStore.getState().pushSnapshot(s.presentation.pages)

    if (!clipState.isCutting) {
      clipState.incrementPasteOffset(20)
    }
    clipState.setNotCutting()

    const currentOffset = useClipboardStore.getState().pasteOffset

    const idMap = new Map<string, string>()
    const groupIdMap = new Map<string, string>()

    const newElements = clipState.items.map((el) => {
      const newEl = structuredClone(el)
      const newId = createElementId()
      idMap.set(el.id, newId)
      newEl.id = newId
      newEl.x += currentOffset
      newEl.y += currentOffset

      if (newEl.groupId) {
        if (!groupIdMap.has(newEl.groupId)) {
          groupIdMap.set(newEl.groupId, createElementId())
        }
        newEl.groupId = groupIdMap.get(newEl.groupId)!
      }

      regenerateNestedIds(newEl)
      if (newEl.locked) newEl.locked = false

      return newEl
    })

    for (const el of newElements) {
      if (el.type === 'line') {
        const line = el as { fromId?: string; toId?: string }
        if (line.fromId && idMap.has(line.fromId)) line.fromId = idMap.get(line.fromId)!
        if (line.toId && idMap.has(line.toId)) line.toId = idMap.get(line.toId)!
      }
    }

    s.addElements(newElements)
  }, [])

  /** 快速复制（PPTist 的 Ctrl+D 就是 copy + paste 的快捷方式） */
  const quickDuplicate = useCallback(() => {
    copy()
    paste()
  }, [copy, paste])

  return { copy, cut, paste, quickDuplicate, hasClipboard }
}
