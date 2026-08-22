import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ViewFilter, ViewGroup, ViewFilterLogic } from '@tabtin/table-core'

const buildScopeKey = (tableId?: string | null, viewId?: string | null) => {
  if (!tableId || !viewId) {
    return null
  }
  return `${tableId}:${viewId}`
}

export interface PersonalViewDraftState {
  filters?: ViewFilter[]
  groups?: ViewGroup[]
  filter_logic?: ViewFilterLogic
  sorts?: Array<{ field_id: string; direction: 'asc' | 'desc' }>
  visible_fields?: string[]
  field_order?: string[]
  column_meta?: Record<string, { order?: number; hidden?: boolean; visible?: boolean; width?: number }>
  config?: Record<string, unknown>
}

interface TableViewUiStore {
  personalViewByScope: Record<string, boolean>
  personalViewDraftByScope: Record<string, PersonalViewDraftState>
  dismissedLockedTipByScope: Record<string, boolean>
  pinnedViewIdsByTable: Record<string, string[]>
  isPersonalViewEnabled: (tableId?: string | null, viewId?: string | null) => boolean
  setPersonalViewEnabled: (tableId: string, viewId: string, enabled: boolean) => void
  togglePersonalView: (tableId: string, viewId: string) => void
  getPersonalViewDraft: (
    tableId?: string | null,
    viewId?: string | null
  ) => PersonalViewDraftState | null
  setPersonalViewDraft: (
    tableId: string,
    viewId: string,
    patch: Partial<PersonalViewDraftState>
  ) => void
  clearPersonalViewFilterDraft: (tableId: string, viewId: string) => void
  clearPersonalViewSortDraft: (tableId: string, viewId: string) => void
  clearPersonalViewDraft: (tableId: string, viewId: string) => void
  isLockedTipDismissed: (tableId?: string | null, viewId?: string | null) => boolean
  dismissLockedTip: (tableId: string, viewId: string) => void
  resetLockedTip: (tableId: string, viewId: string) => void
  isViewPinned: (tableId?: string | null, viewId?: string | null) => boolean
  toggleViewPinned: (tableId: string, viewId: string) => void
  pinView: (tableId: string, viewId: string) => void
  unpinView: (tableId: string, viewId: string) => void
  cleanupStaleScopes: (validTableIds: string[]) => void
  reset: () => void
}

export const useTableViewUiStore = create<TableViewUiStore>()(
  persist(
    (set, get) => ({
      personalViewByScope: {},
      personalViewDraftByScope: {},
      dismissedLockedTipByScope: {},
      pinnedViewIdsByTable: {},

      isPersonalViewEnabled: (tableId, viewId) => {
        const key = buildScopeKey(tableId, viewId)
        if (!key) {
          return false
        }
        return Boolean(get().personalViewByScope[key])
      },

      setPersonalViewEnabled: (tableId, viewId, enabled) => {
        const key = buildScopeKey(tableId, viewId)
        if (!key) {
          return
        }
        set(state => ({
          personalViewByScope: {
            ...state.personalViewByScope,
            [key]: enabled,
          },
          dismissedLockedTipByScope: enabled
            ? {
                ...state.dismissedLockedTipByScope,
                [key]: false,
              }
            : state.dismissedLockedTipByScope,
        }))
      },

      togglePersonalView: (tableId, viewId) => {
        const key = buildScopeKey(tableId, viewId)
        if (!key) {
          return
        }
        const enabled = !Boolean(get().personalViewByScope[key])
        get().setPersonalViewEnabled(tableId, viewId, enabled)
      },

      getPersonalViewDraft: (tableId, viewId) => {
        const key = buildScopeKey(tableId, viewId)
        if (!key) {
          return null
        }
        return get().personalViewDraftByScope[key] ?? null
      },

      setPersonalViewDraft: (tableId, viewId, patch) => {
        const key = buildScopeKey(tableId, viewId)
        if (!key) {
          return
        }

        set(state => {
          const previous = state.personalViewDraftByScope[key] ?? {}
          const nextFilters =
            patch.filters !== undefined
              ? patch.filters.map(item => ({ ...item }))
              : previous.filters
          const nextGroups =
            patch.groups !== undefined
              ? patch.groups.map(item => ({ ...item }))
              : previous.groups
          const nextFilterLogic =
            patch.filter_logic !== undefined ? patch.filter_logic : previous.filter_logic
          const nextConfig =
            patch.config !== undefined
              ? {
                  ...(previous.config ?? {}),
                  ...(patch.config ?? {}),
                }
              : previous.config
          const isFullVisibilityPatch =
            patch.column_meta !== undefined && patch.visible_fields !== undefined
          const nextColumnMeta =
            patch.column_meta !== undefined
              ? isFullVisibilityPatch
                ? { ...patch.column_meta }
                : {
                    ...(previous.column_meta ?? {}),
                    ...Object.fromEntries(
                      Object.entries(patch.column_meta).map(([fieldId, meta]) => {
                        const prevFieldMeta = (previous.column_meta ?? {})[fieldId] ?? {}
                        const patchMeta = meta ?? {}
                        const patchHasVisibility = 'hidden' in patchMeta || 'visible' in patchMeta
                        const base = patchHasVisibility
                          ? (() => { const { hidden: _h, visible: _v, ...rest } = prevFieldMeta; return rest })()
                          : prevFieldMeta
                        return [fieldId, { ...base, ...patchMeta }]
                      })
                    ),
                  }
              : previous.column_meta

          const nextDraft: PersonalViewDraftState = {
            ...previous,
            ...patch,
            ...(nextFilters !== undefined ? { filters: nextFilters } : {}),
            ...(nextGroups !== undefined ? { groups: nextGroups } : {}),
            ...(nextFilterLogic !== undefined ? { filter_logic: nextFilterLogic } : {}),
            ...(patch.sorts !== undefined ? { sorts: [...patch.sorts] } : {}),
            ...(patch.visible_fields !== undefined
              ? { visible_fields: [...patch.visible_fields] }
              : {}),
            ...(patch.field_order !== undefined ? { field_order: [...patch.field_order] } : {}),
            ...(nextColumnMeta !== undefined ? { column_meta: nextColumnMeta } : {}),
            ...(nextConfig !== undefined ? { config: nextConfig } : {}),
          }

          return {
            personalViewDraftByScope: {
              ...state.personalViewDraftByScope,
              [key]: nextDraft,
            },
          }
        })
      },

      clearPersonalViewFilterDraft: (tableId, viewId) => {
        const key = buildScopeKey(tableId, viewId)
        if (!key) {
          return
        }

        set(state => {
          const previous = state.personalViewDraftByScope[key]
          if (!previous) {
            return state
          }

          const { filters: _filters, groups: _groups, filter_logic: _filterLogic, ...restDraft } = previous
          if (Object.keys(restDraft).length === 0) {
            const { [key]: _removed, ...restScopes } = state.personalViewDraftByScope
            return {
              personalViewDraftByScope: restScopes,
            }
          }

          return {
            personalViewDraftByScope: {
              ...state.personalViewDraftByScope,
              [key]: restDraft,
            },
          }
        })
      },

      clearPersonalViewSortDraft: (tableId, viewId) => {
        const key = buildScopeKey(tableId, viewId)
        if (!key) {
          return
        }

        set(state => {
          const previous = state.personalViewDraftByScope[key]
          if (!previous) {
            return state
          }

          const { sorts: _sorts, ...restDraft } = previous
          if (Object.keys(restDraft).length === 0) {
            const { [key]: _removed, ...restScopes } = state.personalViewDraftByScope
            return {
              personalViewDraftByScope: restScopes,
            }
          }

          return {
            personalViewDraftByScope: {
              ...state.personalViewDraftByScope,
              [key]: restDraft,
            },
          }
        })
      },

      clearPersonalViewDraft: (tableId, viewId) => {
        const key = buildScopeKey(tableId, viewId)
        if (!key) {
          return
        }

        set(state => {
          if (!(key in state.personalViewDraftByScope)) {
            return state
          }
          const { [key]: _removed, ...rest } = state.personalViewDraftByScope
          return {
            personalViewDraftByScope: rest,
          }
        })
      },

      isLockedTipDismissed: (tableId, viewId) => {
        const key = buildScopeKey(tableId, viewId)
        if (!key) {
          return false
        }
        return Boolean(get().dismissedLockedTipByScope[key])
      },

      dismissLockedTip: (tableId, viewId) => {
        const key = buildScopeKey(tableId, viewId)
        if (!key) {
          return
        }
        set(state => ({
          dismissedLockedTipByScope: {
            ...state.dismissedLockedTipByScope,
            [key]: true,
          },
        }))
      },

      resetLockedTip: (tableId, viewId) => {
        const key = buildScopeKey(tableId, viewId)
        if (!key) {
          return
        }
        set(state => ({
          dismissedLockedTipByScope: {
            ...state.dismissedLockedTipByScope,
            [key]: false,
          },
        }))
      },

      isViewPinned: (tableId, viewId) => {
        if (!tableId || !viewId) {
          return false
        }
        const pinned = get().pinnedViewIdsByTable[tableId] ?? []
        return pinned.includes(viewId)
      },

      toggleViewPinned: (tableId, viewId) => {
        if (!tableId || !viewId) {
          return
        }
        const pinned = get().pinnedViewIdsByTable[tableId] ?? []
        if (pinned.includes(viewId)) {
          get().unpinView(tableId, viewId)
          return
        }
        get().pinView(tableId, viewId)
      },

      pinView: (tableId, viewId) => {
        if (!tableId || !viewId) {
          return
        }
        set(state => {
          const previous = state.pinnedViewIdsByTable[tableId] ?? []
          if (previous.includes(viewId)) {
            return state
          }
          return {
            pinnedViewIdsByTable: {
              ...state.pinnedViewIdsByTable,
              [tableId]: [...previous, viewId],
            },
          }
        })
      },

      unpinView: (tableId, viewId) => {
        if (!tableId || !viewId) {
          return
        }
        set(state => {
          const previous = state.pinnedViewIdsByTable[tableId] ?? []
          if (!previous.includes(viewId)) {
            return state
          }
          return {
            pinnedViewIdsByTable: {
              ...state.pinnedViewIdsByTable,
              [tableId]: previous.filter(id => id !== viewId),
            },
          }
        })
      },

      cleanupStaleScopes: (validTableIds: string[]) => {
        if (validTableIds.length === 0) return
        const validSet = new Set(validTableIds)

        const isValidScopeKey = (key: string) => {
          const tableId = key.split(':')[0]
          return validSet.has(tableId)
        }

        set(state => {
          const filterObj = <T>(obj: Record<string, T>, predicate: (key: string) => boolean) => {
            const result: Record<string, T> = {}
            for (const key of Object.keys(obj)) {
              if (predicate(key)) result[key] = obj[key]
            }
            return result
          }

          return {
            personalViewByScope: filterObj(state.personalViewByScope, isValidScopeKey),
            personalViewDraftByScope: filterObj(state.personalViewDraftByScope, isValidScopeKey),
            dismissedLockedTipByScope: filterObj(state.dismissedLockedTipByScope, isValidScopeKey),
            pinnedViewIdsByTable: filterObj(state.pinnedViewIdsByTable, k => validSet.has(k)),
          }
        })
      },

      reset: () => {
        set({
          personalViewByScope: {},
          personalViewDraftByScope: {},
          dismissedLockedTipByScope: {},
          pinnedViewIdsByTable: {},
        })
      },
    }),
    {
      name: 'table-view-ui-store',
      partialize: state => ({
        personalViewByScope: state.personalViewByScope,
        personalViewDraftByScope: state.personalViewDraftByScope,
        dismissedLockedTipByScope: state.dismissedLockedTipByScope,
        pinnedViewIdsByTable: state.pinnedViewIdsByTable,
      }),
    }
  )
)
