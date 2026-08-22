import type { PPTElement } from '../types/slides'

export type LayerItem =
  | { kind: 'element'; key: string; element: PPTElement; start: number; end: number; ids: string[]; memberIndices?: number[] }
  | { kind: 'group'; key: string; groupId: string; members: PPTElement[]; start: number; end: number; ids: string[]; memberIndices: number[] }

export const buildLayerItems = (elements: PPTElement[]): LayerItem[] => {
  const groupMap = new Map<string, { members: PPTElement[]; indices: number[] }>()
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    if (!el?.groupId) continue
    let entry = groupMap.get(el.groupId)
    if (!entry) {
      entry = { members: [], indices: [] }
      groupMap.set(el.groupId, entry)
    }
    entry.members.push(el)
    entry.indices.push(i)
  }

  const items: LayerItem[] = []
  const emittedGroups = new Set<string>()

  for (let idx = 0; idx < elements.length; idx++) {
    const current = elements[idx]
    if (!current) break
    const gid = current.groupId
    if (!gid) {
      items.push({ kind: 'element', key: `el:${current.id}`, element: current, start: idx, end: idx, ids: [current.id] })
      continue
    }
    if (emittedGroups.has(gid)) continue
    emittedGroups.add(gid)

    const group = groupMap.get(gid)!
    if (group.members.length <= 1) {
      items.push({ kind: 'element', key: `el:${current.id}`, element: current, start: idx, end: idx, ids: [current.id] })
      continue
    }
    const minIdx = group.indices[0]!
    const maxIdx = group.indices[group.indices.length - 1]!
    items.push({
      kind: 'group',
      key: `group:${gid}:${minIdx}:${maxIdx}`,
      groupId: gid,
      members: group.members,
      start: minIdx,
      end: maxIdx,
      ids: group.members.map((m) => m.id),
      memberIndices: [...group.indices],
    })
  }
  return items
}

export const layerItemSize = (item: LayerItem): number => item.ids.length
