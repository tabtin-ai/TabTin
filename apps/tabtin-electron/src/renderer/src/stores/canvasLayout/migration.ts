import type { CanvasLayoutGroup } from './types'

type CanvasLayoutPersisted = { spaceGroups: Record<string, CanvasLayoutGroup[]> }

export function migrateCanvasLayout(
  persistedState: unknown,
  version: number,
): CanvasLayoutPersisted {
  const state = (persistedState ?? {}) as Record<string, unknown>

  if (version < 1) {
    if (state.projectGroups && !state.spaceGroups) {
      state.spaceGroups = state.projectGroups
      delete state.projectGroups
    }

    if (state.spaceGroups) {
      for (const [, groups] of Object.entries(
        state.spaceGroups as Record<string, unknown[]>,
      )) {
        if (!Array.isArray(groups)) continue
        for (const group of groups as Record<string, unknown>[]) {
          if (!group.spaceId && group.projectId) {
            group.spaceId = String(group.projectId)
          }
          delete group.projectId
          if (!group.layout && Array.isArray(group.panes) && group.panes.length > 0) {
            const direction = (group.direction as string) || 'horizontal'
            const paneIds = (group.panes as { id: string }[]).map(p => p.id)
            if (paneIds.length <= 1) {
              group.layout = { type: 'leaf', paneId: paneIds[0] || 'orphan' }
            } else {
              group.layout = {
                type: 'split',
                id: `split-migrated-${crypto.randomUUID()}`,
                direction,
                children: paneIds.map((id: string) => ({ type: 'leaf', paneId: id })),
                sizes: paneIds.map(() => 1 / paneIds.length),
              }
            }
            delete group.direction
          }
        }
      }
    }
  }

  return state as CanvasLayoutPersisted
}
