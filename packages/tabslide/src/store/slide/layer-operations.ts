import type { PPTElement, Slide } from '../../types/slides'

export type GroupSpan = {
  groupId: string
  members: PPTElement[]
  start: number
  end: number
}

/**
 * 将输入 ID 扩展为“完整组语义”的选择集：
 * - 只要命中组内任一成员，就补齐该组全部成员
 * - 返回顺序与当前图层顺序一致，便于后续批量操作稳定可预期
 */
export const expandSelectionToWholeGroups = (page: Slide, ids: string[]): string[] => {
  if (ids.length === 0) return []
  const selected = new Set(ids)
  const hitGroupIds = new Set<string>()

  for (const el of page.elements) {
    if (selected.has(el.id) && el.groupId) {
      hitGroupIds.add(el.groupId)
    }
  }

  if (hitGroupIds.size > 0) {
    for (const el of page.elements) {
      if (el.groupId && hitGroupIds.has(el.groupId)) {
        selected.add(el.id)
      }
    }
  }

  return page.elements.filter((el) => selected.has(el.id)).map((el) => el.id)
}

/**
 * 将选中元素压缩为连续图层块。
 * 后端导出 grpSp 依赖组成员在 z 序上连续；这里在前端组合时一次性规范化，
 * 避免出现“编辑器里已组合、导出后丢组”的链路断层。
 */
export const compactSelectionToContiguousBlock = (page: Slide, selectedIds: Set<string>) => {
  if (selectedIds.size < 2) return

  const selectedEls: PPTElement[] = []
  const remainedEls: PPTElement[] = []
  let insertAt = 0
  let seenSelected = false

  for (const el of page.elements) {
    if (selectedIds.has(el.id)) {
      selectedEls.push(el)
      seenSelected = true
      continue
    }
    if (!seenSelected) insertAt += 1
    remainedEls.push(el)
  }

  if (selectedEls.length < 2) return

  page.elements = [
    ...remainedEls.slice(0, insertAt),
    ...selectedEls,
    ...remainedEls.slice(insertAt),
  ]
}

export const findGroupSpan = (elements: PPTElement[], groupId: string): GroupSpan | null => {
  const members: PPTElement[] = []
  const indices: number[] = []

  elements.forEach((el, idx) => {
    if (el.groupId === groupId) {
      members.push(el)
      indices.push(idx)
    }
  })

  if (indices.length === 0) return null
  return {
    groupId,
    members,
    start: indices[0]!,
    end: indices[indices.length - 1]!,
  }
}

export const ensureGroupContiguousBlock = (elements: PPTElement[], groupId: string): GroupSpan | null => {
  const span = findGroupSpan(elements, groupId)
  if (!span) return null
  if (span.members.length <= 1) return span

  const isContiguous = span.end - span.start + 1 === span.members.length
  if (isContiguous) return span

  // 组被打散时，先压缩回连续块，避免后续图层操作继续破坏组合语义
  const remaining = elements.filter((el) => el.groupId !== groupId)
  const insertAt = Math.min(span.start, remaining.length)
  elements.splice(
    0,
    elements.length,
    ...remaining.slice(0, insertAt),
    ...span.members,
    ...remaining.slice(insertAt),
  )
  return {
    groupId,
    members: span.members,
    start: insertAt,
    end: insertAt + span.members.length - 1,
  }
}

export const reorderGroupBlock = (
  elements: PPTElement[],
  groupId: string,
  to: number,
): boolean => {
  const span = ensureGroupContiguousBlock(elements, groupId)
  if (!span || span.members.length <= 1) return false
  const memberIdSet = new Set(span.members.map((el) => el.id))
  const remaining = elements.filter((el) => !memberIdSet.has(el.id))
  const insertAt = Math.max(0, Math.min(remaining.length, Math.trunc(to)))
  const nextOrder = [
    ...remaining.slice(0, insertAt),
    ...span.members,
    ...remaining.slice(insertAt),
  ]

  const changed = nextOrder.some((el, idx) => el !== elements[idx])
  if (!changed) return false
  elements.splice(0, elements.length, ...nextOrder)
  return true
}

export const expandIdsToAtomicBlocks = (elements: PPTElement[], ids: string[]): string[] => {
  if (ids.length === 0) return []
  const selected = new Set(ids)
  const hitGroupIds = new Set<string>()

  for (const el of elements) {
    if (selected.has(el.id) && el.groupId) {
      hitGroupIds.add(el.groupId)
    }
  }
  if (hitGroupIds.size > 0) {
    for (const el of elements) {
      if (el.groupId && hitGroupIds.has(el.groupId)) {
        selected.add(el.id)
      }
    }
  }
  return elements.filter((el) => selected.has(el.id)).map((el) => el.id)
}

/**
 * 解析可参与图层移动的元素 ID（含组语义）：
 * - 单元素：locked=true 时不可移动
 * - 组合元素：任一成员 locked=true，则整组不可移动（保持原子性）
 */
export const resolveMovableLayerIds = (elements: PPTElement[], ids: string[]): string[] => {
  if (ids.length === 0 || elements.length === 0) return []
  const selected = new Set(ids)
  const movable = new Set<string>()
  const touchedGroupIds = new Set<string>()
  const groupMembers = new Map<string, PPTElement[]>()

  for (const el of elements) {
    if (!el.groupId) continue
    const members = groupMembers.get(el.groupId)
    if (members) {
      members.push(el)
    } else {
      groupMembers.set(el.groupId, [el])
    }
  }

  for (const el of elements) {
    if (!selected.has(el.id)) continue
    if (el.groupId) {
      touchedGroupIds.add(el.groupId)
      continue
    }
    if (!el.locked) {
      movable.add(el.id)
    }
  }

  for (const gid of touchedGroupIds) {
    const members = groupMembers.get(gid)
    if (!members || members.length === 0) continue
    if (members.some((member) => member.locked)) {
      continue
    }
    for (const member of members) {
      movable.add(member.id)
    }
  }

  return elements.filter((el) => movable.has(el.id)).map((el) => el.id)
}

export const moveSelectionByOneLayer = (
  elements: PPTElement[],
  selectedIds: Set<string>,
  direction: 'forward' | 'backward',
): boolean => {
  let changed = false

  if (direction === 'forward') {
    for (let idx = elements.length - 2; idx >= 0; idx -= 1) {
      const currentEl = elements[idx]
      const next = elements[idx + 1]
      if (!currentEl || !next) continue
      if (selectedIds.has(currentEl.id) && !selectedIds.has(next.id)) {
        ;[elements[idx], elements[idx + 1]] = [elements[idx + 1], elements[idx]]
        changed = true
      }
    }
    return changed
  }

  for (let idx = 1; idx < elements.length; idx += 1) {
    const currentEl = elements[idx]
    const prev = elements[idx - 1]
    if (!currentEl || !prev) continue
    if (selectedIds.has(currentEl.id) && !selectedIds.has(prev.id)) {
      ;[elements[idx], elements[idx - 1]] = [elements[idx - 1], elements[idx]]
      changed = true
    }
  }
  return changed
}

export const moveSelectionToEdge = (
  elements: PPTElement[],
  selectedIds: Set<string>,
  edge: 'front' | 'back',
): boolean => {
  if (selectedIds.size === 0) return false
  const selectedEls = elements.filter((el) => selectedIds.has(el.id))
  const unselectedEls = elements.filter((el) => !selectedIds.has(el.id))
  if (selectedEls.length === 0) return false

  const nextOrder = edge === 'front'
    ? [...unselectedEls, ...selectedEls]
    : [...selectedEls, ...unselectedEls]

  const changed = elements.some((el, idx) => el !== nextOrder[idx])
  if (!changed) return false
  elements.splice(0, elements.length, ...nextOrder)
  return true
}
