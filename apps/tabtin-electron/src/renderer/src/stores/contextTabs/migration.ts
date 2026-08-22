/**
 * Persist migration logic for useSpaceContextTabsStore.
 * Contains one-time v0→v1 migration: property renames (project→space),
 * legacy data merging, and tab-key prefix migration.
 */

import { buildTableKey, buildActiveKeyFromLegacy } from './helpers'

// ---------------------------------------------------------------------------
// v0 → v1
// ---------------------------------------------------------------------------

const TAB_KEY_MIGRATION: Record<string, string> = {
  'table:': 'tabdata:',
  'app-tabdoc:': 'tabdoc:',
  'ppt:': 'tabslide:',
}

const EXACT_KEY_MIGRATION: Record<string, string> = {
  'tabdoc:tabdoc': 'tabdoc:home',
}

const TYPE_MIGRATION: Record<string, string> = {
  'table': 'tabdata',
  'app-tabdoc': 'tabdoc',
  'ppt': 'tabslide',
}

const migrateTabKey = (key: string): string => {
  for (const [oldPrefix, newPrefix] of Object.entries(TAB_KEY_MIGRATION)) {
    if (key.startsWith(oldPrefix)) {
      const migrated = newPrefix + key.slice(oldPrefix.length)
      return EXACT_KEY_MIGRATION[migrated] ?? migrated
    }
  }
  return EXACT_KEY_MIGRATION[key] ?? key
}

function migrateV0ToV1(state: Record<string, any>) {
  // Property renames: project → space
  if (state.activeKeyByProject && !state.activeKeyBySpace) {
    state.activeKeyBySpace = state.activeKeyByProject
    delete state.activeKeyByProject
  }
  if (state.displayKeyByProject && !state.displayKeyBySpace) {
    state.displayKeyBySpace = state.displayKeyByProject
    delete state.displayKeyByProject
  }
  if (state.tabOrderByProject && !state.tabOrderBySpace) {
    state.tabOrderBySpace = state.tabOrderByProject
    delete state.tabOrderByProject
  }
  if (state.itemsByProject && !state.itemsBySpace) {
    state.itemsBySpace = state.itemsByProject
    delete state.itemsByProject
  }

  // Legacy openTableTabsByProject → merge into tabOrderBySpace
  const legacyOpenTables = state.openTableTabsByProject as Record<string, string[]> | undefined
  if (legacyOpenTables) {
    const nextOrder = { ...(state.tabOrderBySpace || {}) }
    Object.entries(legacyOpenTables).forEach(([asId, tableIds]) => {
      if (!Array.isArray(tableIds) || tableIds.length === 0) return
      const existing = nextOrder[asId] ? [...nextOrder[asId]] : []
      const existingSet = new Set(existing)
      tableIds.forEach((tableId: string) => {
        const key = buildTableKey(tableId)
        if (!existingSet.has(key)) existing.push(key)
      })
      nextOrder[asId] = existing
    })
    state.tabOrderBySpace = nextOrder
    delete state.openTableTabsByProject
  }

  // Legacy activeTabByProject → merge into activeKeyBySpace
  const legacyActiveTabs = state.activeTabByProject as Record<string, any> | undefined
  if (legacyActiveTabs) {
    const nextActive = { ...(state.activeKeyBySpace || {}) }
    Object.entries(legacyActiveTabs).forEach(([asId, tab]) => {
      if (nextActive[asId] !== undefined) return
      nextActive[asId] = buildActiveKeyFromLegacy(tab)
    })
    state.activeKeyBySpace = nextActive
    delete state.activeTabByProject
  }

  // Tab key prefix migration
  if (state.tabOrderBySpace) {
    const migrated: Record<string, string[]> = {}
    Object.entries(state.tabOrderBySpace).forEach(([asId, keys]) => {
      if (Array.isArray(keys)) migrated[asId] = keys.map(migrateTabKey)
    })
    state.tabOrderBySpace = migrated
  }
  if (state.activeKeyBySpace) {
    const migrated: Record<string, any> = {}
    Object.entries(state.activeKeyBySpace).forEach(([asId, key]) => {
      migrated[asId] = typeof key === 'string' ? migrateTabKey(key) : key
    })
    state.activeKeyBySpace = migrated
  }
  if (state.itemsBySpace) {
    const migrated: Record<string, Record<string, any>> = {}
    Object.entries(state.itemsBySpace).forEach(([asId, items]) => {
      const newItems: Record<string, any> = {}
      Object.entries(items || {}).forEach(([tabKey, item]: [string, any]) => {
        const newKey = migrateTabKey(tabKey)
        newItems[newKey] = { ...item, tabKey: newKey, type: TYPE_MIGRATION[item?.type] ?? item?.type }
      })
      migrated[asId] = newItems
    })
    state.itemsBySpace = migrated
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function migrateContextTabsState<T>(persistedState: unknown, version: number): T {
  const state = (persistedState ?? {}) as Record<string, any>
  if (version < 1) {
    migrateV0ToV1(state)
  }
  return state as T
}
