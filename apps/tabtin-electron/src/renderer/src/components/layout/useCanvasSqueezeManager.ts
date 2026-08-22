import { useRef, type RefObject } from 'react'
import type { DropSide, SqueezeIntent } from './canvas-drag-types'
import type { CanvasTabKey } from '@stores/useCanvasLayoutStore'
import {
  getPaneContentElement,
  getContentRootElement,
  getGroupContentElement,
  resetSqueezeStyles,
  clearAllSqueezeEffects,
  applySqueezeToElement,
  applySqueezeEffect,
} from './canvas-squeeze-effects'

interface SqueezeManagerOptions {
  contentRootRef: RefObject<HTMLElement | null>
  latestActiveTabKey: () => CanvasTabKey | null
  emitLayoutChange: () => void
}

export function useCanvasSqueezeManager({
  contentRootRef,
  latestActiveTabKey,
  emitLayoutChange,
}: SqueezeManagerOptions) {
  const squeezedPanesRef = useRef<{ paneIds: string[]; side: DropSide } | null>(null)
  const contentRootSqueezedRef = useRef<DropSide | null>(null)
  const groupSqueezedRef = useRef<{ groupId: string; side: DropSide } | null>(null)
  const contentSqueezeTargetRef = useRef<HTMLElement | null>(null)

  const resolveActiveContentElement = (): HTMLElement | null => {
    const root = contentRootRef.current
    if (!root) return null
    const activeKey = latestActiveTabKey()
    if (!activeKey) return null
    const delimiterIndex = activeKey.indexOf(':')
    if (delimiterIndex <= 0) return null
    const type = activeKey.slice(0, delimiterIndex)
    const id = activeKey.slice(delimiterIndex + 1)
    if (!id) return null

    if (type === 'tabdata') {
      return (
        root.querySelector<HTMLElement>(`[data-table-tab-id="${id}"]`) ||
        root.querySelector<HTMLElement>(`[data-table-pane-slot="${id}"]`)
      )
    }
    if (type === 'tabweb') {
      return (
        root.querySelector<HTMLElement>(`[data-crawlspace-view-id="${id}"]`) ||
        root.querySelector<HTMLElement>(`[data-canvas-view-id="${id}"]`)
      )
    }
    if (type === 'terminal') {
      return root.querySelector<HTMLElement>(`[data-terminal-pane-id="${id}"]`)
    }
    return null
  }

  const resolveContentSqueezeElement = (): HTMLElement | null => {
    return resolveActiveContentElement() ?? getContentRootElement(contentRootRef.current)
  }

  const resolveContentSqueezeContainer = (): HTMLElement | null => {
    const target = resolveContentSqueezeElement()
    return target?.parentElement ?? getContentRootElement(contentRootRef.current)
  }

  /**
   * 更新挤压效果（独立于 dropIntent）
   * 支持单个 pane、多个 pane 或内容区域的挤压
   */
  const updateSqueezeEffect = (intent: SqueezeIntent | null) => {
    let changed = false
    let targetPaneIds: string[] = []
    let targetSide: DropSide | null = null
    let isContentRootTarget = false
    let targetGroupId: string | null = null

    if (intent) {
      if (intent.kind === 'pane') {
        targetPaneIds = [intent.paneId]
        targetSide = intent.side
      } else if (intent.kind === 'multi-pane') {
        targetPaneIds = intent.paneIds
        targetSide = intent.side
      } else if (intent.kind === 'group') {
        targetGroupId = intent.groupId
        targetSide = intent.side
      } else if (intent.kind === 'content') {
        isContentRootTarget = true
        targetSide = intent.side
      }
    }

    const previousPanes = squeezedPanesRef.current
    const previousContentRoot = contentRootSqueezedRef.current
    const previousGroup = groupSqueezedRef.current

    const isSamePaneSet = (a: string[], b: string[]) => {
      if (a.length !== b.length) return false
      const sortedA = [...a].sort()
      const sortedB = [...b].sort()
      return sortedA.every((id, i) => id === sortedB[i])
    }

    // 清除之前的 pane 挤压效果（如果目标发生变化）
    if (previousPanes) {
      const needsClear = !isSamePaneSet(previousPanes.paneIds, targetPaneIds) || previousPanes.side !== targetSide
      if (needsClear) {
        for (const paneId of previousPanes.paneIds) {
          const prevEl = getPaneContentElement(paneId, contentRootRef.current)
          if (prevEl) {
            resetSqueezeStyles(prevEl)
          }
        }
        squeezedPanesRef.current = null
        changed = true
      }
    }

    // 清除之前的 group 挤压效果
    if (previousGroup && (!targetGroupId || previousGroup.groupId !== targetGroupId || previousGroup.side !== targetSide)) {
      const prevGroupEl = getGroupContentElement(previousGroup.groupId, contentRootRef.current)
      if (prevGroupEl) {
        resetSqueezeStyles(prevGroupEl)
      }
      groupSqueezedRef.current = null
      changed = true
    }

    // 清除之前的内容区域挤压效果
    if (previousContentRoot && (!isContentRootTarget || previousContentRoot !== targetSide)) {
      const prevTarget =
        contentSqueezeTargetRef.current ?? getContentRootElement(contentRootRef.current)
      if (prevTarget) {
        resetSqueezeStyles(prevTarget)
      }
      contentRootSqueezedRef.current = null
      contentSqueezeTargetRef.current = null
      changed = true
    }

    // 应用新的挤压效果
    if (targetGroupId && targetSide) {
      const needsApply =
        !previousGroup ||
        previousGroup.groupId !== targetGroupId ||
        previousGroup.side !== targetSide
      const groupEl = getGroupContentElement(targetGroupId, contentRootRef.current)
      if (groupEl && needsApply) {
        applySqueezeToElement(groupEl, targetSide)
        groupSqueezedRef.current = { groupId: targetGroupId, side: targetSide }
        changed = true
      }
    } else if (isContentRootTarget && targetSide) {
      // create-group: 挤压内容区域
      if (contentRootSqueezedRef.current !== targetSide) {
        const contentTarget = resolveContentSqueezeElement()
        if (contentTarget) {
          applySqueezeToElement(contentTarget, targetSide)
          contentSqueezeTargetRef.current = contentTarget
          contentRootSqueezedRef.current = targetSide
          changed = true
        }
      }
    } else if (targetPaneIds.length > 0 && targetSide) {
      // split/move: 挤压指定 pane(s)
      const needsApply = !previousPanes || !isSamePaneSet(previousPanes.paneIds, targetPaneIds) || previousPanes.side !== targetSide
      if (needsApply) {
        for (const paneId of targetPaneIds) {
          applySqueezeEffect(paneId, targetSide, contentRootRef.current)
        }
        squeezedPanesRef.current = { paneIds: targetPaneIds, side: targetSide }
        changed = true
      }
    }

    if (changed) {
      emitLayoutChange()
    }
  }

  const cleanupSqueeze = () => {
    const hadSqueeze = Boolean(
      squeezedPanesRef.current ||
      groupSqueezedRef.current ||
      contentRootSqueezedRef.current,
    )
    contentSqueezeTargetRef.current = null
    clearAllSqueezeEffects(contentRootRef.current)
    squeezedPanesRef.current = null
    groupSqueezedRef.current = null
    contentRootSqueezedRef.current = null
    if (hadSqueeze) {
      emitLayoutChange()
    }
  }

  return {
    updateSqueezeEffect,
    resolveContentSqueezeElement,
    resolveContentSqueezeContainer,
    cleanupSqueeze,
  }
}
