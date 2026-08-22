export type ViewDraftSection = 'filters' | 'groups' | 'sorts'

export interface ViewDraftSectionState {
  filters: unknown[]
  filter_logic: 'and' | 'or'
  groups: unknown[]
  sorts: unknown[]
  isDirty: boolean
}

export const restoreViewDraftSection = <
  Draft extends ViewDraftSectionState,
  PersistedDraft extends ViewDraftSectionState,
>(
  currentDraft: Draft,
  persistedDraft: PersistedDraft,
  section: ViewDraftSection,
): Draft => {
  if (section === 'filters') {
    return {
      ...currentDraft,
      filters: [...persistedDraft.filters],
      filter_logic: persistedDraft.filter_logic,
    }
  }

  if (section === 'groups') {
    return {
      ...currentDraft,
      groups: [...persistedDraft.groups],
    }
  }

  return {
    ...currentDraft,
    sorts: [...persistedDraft.sorts],
  }
}
