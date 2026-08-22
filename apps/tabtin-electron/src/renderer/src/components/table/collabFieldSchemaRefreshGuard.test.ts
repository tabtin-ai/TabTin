import { describe, expect, it } from 'vitest'

import {
  markDeletedFieldSchemaTombstone,
  planFieldSchemaViewRefresh,
  shouldReconcileSchemaOnCollabOnline,
  shouldReconcileSchemaOnTabActivate,
  shouldSkipFieldSchemaRefreshForRecentLocalDelete,
} from './collabFieldSchemaRefreshGuard'

describe('collabFieldSchemaRefreshGuard', () => {
  it('skips schema refresh only for delete_field echo of a recently deleted local field', () => {
    const tombstones = new Map<string, number>()
    markDeletedFieldSchemaTombstone(tombstones, 'field-copy', 1_000)

    expect(
      shouldSkipFieldSchemaRefreshForRecentLocalDelete(
        { action: 'delete_field', field_ids: ['field-copy'] },
        tombstones,
        2_000,
      ),
    ).toBe(true)
  })

  it('allows restore_field / create_field even when tombstone is present ', () => {
    const tombstones = new Map<string, number>()
    markDeletedFieldSchemaTombstone(tombstones, 'field-copy', 1_000)

    expect(
      shouldSkipFieldSchemaRefreshForRecentLocalDelete(
        { action: 'restore_field', field_ids: ['field-copy'] },
        tombstones,
        2_000,
      ),
    ).toBe(false)
    expect(
      shouldSkipFieldSchemaRefreshForRecentLocalDelete(
        { action: 'create_field', field_ids: ['field-copy'] },
        tombstones,
        2_000,
      ),
    ).toBe(false)
  })

  it('allows schema refresh for unrelated field delete events', () => {
    const tombstones = new Map<string, number>()
    markDeletedFieldSchemaTombstone(tombstones, 'field-copy', 1_000)

    expect(
      shouldSkipFieldSchemaRefreshForRecentLocalDelete(
        { action: 'delete_field', field_ids: ['field-other'] },
        tombstones,
        2_000,
      ),
    ).toBe(false)
  })

  it('allows schema refresh after the deleted-field tombstone expires', () => {
    const tombstones = new Map<string, number>()
    markDeletedFieldSchemaTombstone(tombstones, 'field-copy', 1_000)

    expect(
      shouldSkipFieldSchemaRefreshForRecentLocalDelete(
        { action: 'delete_field', field_ids: ['field-copy'] },
        tombstones,
        123_001,
      ),
    ).toBe(false)
    expect(tombstones.has('field-copy')).toBe(false)
  })

  it('plans preserve view refresh for create_field / delete_field / restore_field', () => {
    expect(planFieldSchemaViewRefresh('create_field')).toBe('preserve')
    expect(planFieldSchemaViewRefresh('delete_field')).toBe('preserve')
    expect(planFieldSchemaViewRefresh('restore_field')).toBe('preserve')
    expect(planFieldSchemaViewRefresh('schema_stack_sync')).toBe('preserve')
    expect(planFieldSchemaViewRefresh('batch_create_fields')).toBe('preserve')
  })

  it('plans no view refresh for update_field', () => {
    expect(planFieldSchemaViewRefresh('update_field')).toBe('none')
  })

  it('#8151 reconciles schema only on transition into collab online', () => {
    expect(shouldReconcileSchemaOnCollabOnline(false, true)).toBe(true)
    expect(shouldReconcileSchemaOnCollabOnline(true, true)).toBe(false)
    expect(shouldReconcileSchemaOnCollabOnline(true, false)).toBe(false)
    expect(shouldReconcileSchemaOnCollabOnline(false, false)).toBe(false)
  })

  it('#8151 reconciles schema when tab becomes active', () => {
    expect(shouldReconcileSchemaOnTabActivate(false, true)).toBe(true)
    expect(shouldReconcileSchemaOnTabActivate(true, true)).toBe(false)
    expect(shouldReconcileSchemaOnTabActivate(true, false)).toBe(false)
  })
})
