import type {
  CanvasLayoutGroup,
  CanvasLayoutNode,
  CanvasLayoutDirection,
} from './types'
import {
  createSplitId,
  buildSizes,
  collectLeafIds,
} from '@/utils/split-layout'
import { emitSplitEvent, type SplitEventType } from '@/utils/split-coordinator'

export const MAX_PANES_PER_GROUP = 3

export const EMPTY_CANVAS_GROUPS: CanvasLayoutGroup[] = []

export const createId = (prefix: string) => createSplitId(prefix)

export const findGroupById = (
  groups: CanvasLayoutGroup[],
  groupId: string,
): CanvasLayoutGroup | null =>
  groups.find(group => group.id === groupId) || null

export const findGroupForTabKey = (
  groups: readonly CanvasLayoutGroup[],
  tabKey: string,
): CanvasLayoutGroup | null =>
  groups.find(group =>
    group.panes.some(pane => pane.content?.tabKey === tabKey),
  ) || null

export const ensureLayout = (group: CanvasLayoutGroup): CanvasLayoutNode => {
  if (group.layout) return group.layout
  const { panes } = group
  if (panes.length <= 1) {
    return { type: 'leaf', paneId: panes[0]?.id || createId('pane') }
  }
  const legacyDirection =
    (group as { direction?: CanvasLayoutDirection }).direction || 'horizontal'
  return {
    type: 'split',
    id: createId('split'),
    direction: legacyDirection,
    children: panes.map(pane => ({ type: 'leaf', paneId: pane.id })),
    sizes: buildSizes(panes.length),
  }
}

export const repairGroupConsistency = (
  group: CanvasLayoutGroup,
  spaceIdHint?: string,
): CanvasLayoutGroup => {
  const normalizedSpaceId =
    group.spaceId ||
    (group as { projectId?: string }).projectId ||
    spaceIdHint ||
    ''

  if (!group.layout) {
    return {
      ...group,
      spaceId: normalizedSpaceId,
      layout: ensureLayout(group),
    }
  }

  const layoutPaneIds = new Set(collectLeafIds(group.layout))
  const paneIds = new Set(group.panes.map(p => p.id))

  const orphanLeafIds = [...layoutPaneIds].filter(id => !paneIds.has(id))
  const orphanPanes = group.panes.filter(p => !layoutPaneIds.has(p.id))

  if (orphanLeafIds.length === 0 && orphanPanes.length === 0) {
    return group.spaceId === normalizedSpaceId
      ? group
      : { ...group, spaceId: normalizedSpaceId }
  }

  // INT-11: 所有环境均输出警告，包括孤立 pane 的 content 摘要
  console.warn('[CanvasLayout] Consistency fix — orphan panes will be discarded', {
    groupId: group.id,
    orphanLeafIds,
    orphanPanes: orphanPanes.map(p => ({
      id: p.id,
      tabKey: p.content?.tabKey ?? null,
      contentType: p.content ? 'present' : 'empty',
    })),
  })

  let nextPanes = [...group.panes]
  for (const orphanId of orphanLeafIds) {
    nextPanes.push({ id: orphanId, content: null })
  }
  nextPanes = nextPanes.filter(p => layoutPaneIds.has(p.id))

  const nextActivePaneId = nextPanes.some(p => p.id === group.activePaneId)
    ? group.activePaneId
    : nextPanes[0]?.id || null

  let nextAnchor = group.anchorTabKey
  if (!nextPanes.some(p => p.content?.tabKey === group.anchorTabKey)) {
    const fallback = nextPanes.find(p => p.content?.tabKey)
    nextAnchor = fallback?.content?.tabKey ?? group.anchorTabKey
  }

  return {
    ...group,
    spaceId: normalizedSpaceId,
    panes: nextPanes,
    anchorTabKey: nextAnchor,
    activePaneId: nextActivePaneId,
    updatedAt: Date.now(),
  }
}

/**
 * 通用 group 更新辅助。
 * updater 返回新 group 则写回，返回 null 则不变（调用方用 `?? state` 处理）。
 */
export function withGroupUpdate(
  spaceGroups: Record<string, CanvasLayoutGroup[]>,
  spaceId: string,
  groupId: string,
  updater: (group: CanvasLayoutGroup, groups: CanvasLayoutGroup[]) => CanvasLayoutGroup | null,
): { spaceGroups: Record<string, CanvasLayoutGroup[]> } | null {
  const groups = spaceGroups[spaceId] ?? EMPTY_CANVAS_GROUPS
  const group = findGroupById(groups, groupId)
  if (!group) return null
  const next = updater(group, groups)
  if (!next) return null
  return {
    spaceGroups: {
      ...spaceGroups,
      [spaceId]: groups.map(item => (item.id === groupId ? next : item)),
    },
  }
}

export function emitCanvasEvent(spaceId: string, type: SplitEventType): void {
  emitSplitEvent({ system: 'canvas', type, spaceId: spaceId })
}
