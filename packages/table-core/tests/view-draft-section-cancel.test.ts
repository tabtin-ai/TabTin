import assert from 'node:assert/strict'
import test from 'node:test'

import { restoreViewDraftSection } from '../src/domain/view-draft-section.js'

const savedViewDraft = {
  filters: [
    { id: 'filter-1', field_id: 'submitter', operator: 'eq', value: 'owner' },
  ],
  filter_logic: 'and' as const,
  groups: [{ field_id: 'status', direction: 'asc' as const }],
  sorts: [{ field_id: 'description', direction: 'asc' as const }],
  isDirty: false,
}

const persistedViewDraftBeforeCollabSave = {
  ...savedViewDraft,
  filters: [],
  sorts: [],
}

test('取消分组草稿只回滚分组，保留已经保存的筛选和排序', () => {
  const currentDraft = {
    ...savedViewDraft,
    groups: [],
    isDirty: true,
  }

  const restored = restoreViewDraftSection(
    currentDraft,
    persistedViewDraftBeforeCollabSave,
    'groups',
  )

  assert.deepEqual(restored.filters, savedViewDraft.filters)
  assert.deepEqual(restored.sorts, savedViewDraft.sorts)
  assert.deepEqual(restored.groups, savedViewDraft.groups)
})

test('取消任一面板草稿都不会改动另外两类配置', () => {
  const currentDraft = {
    filters: [
      { id: 'filter-2', field_id: 'severity', operator: 'eq', value: 'P2' },
    ],
    filter_logic: 'or' as const,
    groups: [],
    sorts: [{ field_id: 'created_at', direction: 'desc' as const }],
    isDirty: true,
  }

  const restoredFilters = restoreViewDraftSection(
    currentDraft,
    savedViewDraft,
    'filters',
  )
  assert.deepEqual(restoredFilters.groups, currentDraft.groups)
  assert.deepEqual(restoredFilters.sorts, currentDraft.sorts)

  const restoredSorts = restoreViewDraftSection(
    currentDraft,
    savedViewDraft,
    'sorts',
  )
  assert.deepEqual(restoredSorts.filters, currentDraft.filters)
  assert.equal(restoredSorts.filter_logic, currentDraft.filter_logic)
  assert.deepEqual(restoredSorts.groups, currentDraft.groups)
})
