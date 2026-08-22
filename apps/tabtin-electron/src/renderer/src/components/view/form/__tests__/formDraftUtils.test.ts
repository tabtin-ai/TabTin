/**
 * Regression tests for formDraftUtils, FormPreviewer, and FormBody draft system.
 *
 * Covers:
 *   EMF-004 / FMF-007 — draft key includes userId to prevent cross-account pollution
 *   EMF-016           — draft key includes namespace for scenario isolation
 *   FMF-008 / FMF-026 — handleFillAgain clears draft immediately (tested via clearDraft call)
 *   FMF-025           — both components share the same draft utility module
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { getDraftKey, readDraft, writeDraft, clearDraft } from '../formDraftUtils'

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

const store: Record<string, string> = {}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]

  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => { store[key] = val },
      removeItem: (key: string) => { delete store[key] },
    },
    writable: true,
  })
})

// ---------------------------------------------------------------------------
// getDraftKey
// ---------------------------------------------------------------------------

describe('getDraftKey', () => {
  it('includes userId to prevent cross-account pollution (EMF-004 / FMF-007)', () => {
    const keyA = getDraftKey({ tableId: 't1', viewId: 'v1', userId: 'user-A' })
    const keyB = getDraftKey({ tableId: 't1', viewId: 'v1', userId: 'user-B' })
    expect(keyA).not.toEqual(keyB)
    expect(keyA).toContain('user-A')
    expect(keyB).toContain('user-B')
  })

  it('falls back to "anonymous" when userId is null/undefined', () => {
    const key1 = getDraftKey({ tableId: 't1', viewId: 'v1', userId: null })
    const key2 = getDraftKey({ tableId: 't1', viewId: 'v1' })
    expect(key1).toEqual(key2)
    expect(key1).toContain('anonymous')
  })

  it('includes namespace for scenario isolation (EMF-016)', () => {
    const editorKey = getDraftKey({ tableId: 't1', viewId: 'v1', userId: 'u1', namespace: 'editor' })
    const publicKey = getDraftKey({ tableId: 't1', viewId: 'v1', userId: 'u1', namespace: 'public' })
    expect(editorKey).not.toEqual(publicKey)
    expect(editorKey).toContain('editor')
    expect(publicKey).toContain('public')
  })

  it('defaults namespace to "editor"', () => {
    const keyDefault = getDraftKey({ tableId: 't1', viewId: 'v1', userId: 'u1' })
    const keyExplicit = getDraftKey({ tableId: 't1', viewId: 'v1', userId: 'u1', namespace: 'editor' })
    expect(keyDefault).toEqual(keyExplicit)
  })

  it('produces deterministic keys with the expected format', () => {
    const key = getDraftKey({ tableId: 'tbl_abc', viewId: 'viw_123', userId: 'uid_x', namespace: 'embed' })
    expect(key).toBe('tabtin-form-draft:embed:uid_x:tbl_abc:viw_123')
  })
})

// ---------------------------------------------------------------------------
// readDraft / writeDraft / clearDraft
// ---------------------------------------------------------------------------

describe('draft read/write/clear', () => {
  const key = getDraftKey({ tableId: 't1', viewId: 'v1', userId: 'u1' })

  it('writeDraft → readDraft round-trip', () => {
    const values = { field1: 'hello', field2: 42 }
    writeDraft(key, values)
    expect(readDraft(key)).toEqual(values)
  })

  it('clearDraft removes the draft (FMF-008 / FMF-026)', () => {
    writeDraft(key, { x: 1 })
    expect(readDraft(key)).not.toBeNull()
    clearDraft(key)
    expect(readDraft(key)).toBeNull()
  })

  it('readDraft returns null for expired drafts (> 24h)', () => {
    const expired = { values: { a: 1 }, updatedAt: Date.now() - 25 * 60 * 60 * 1000 }
    store[key] = JSON.stringify(expired)
    expect(readDraft(key)).toBeNull()
    // expired entry should be removed
    expect(store[key]).toBeUndefined()
  })

  it('readDraft returns null for invalid JSON', () => {
    store[key] = '{bad json'
    expect(readDraft(key)).toBeNull()
  })

  it('user A cannot read user B draft even with same table/view (EMF-004)', () => {
    const keyA = getDraftKey({ tableId: 't1', viewId: 'v1', userId: 'A' })
    const keyB = getDraftKey({ tableId: 't1', viewId: 'v1', userId: 'B' })
    writeDraft(keyA, { secret: 'A-data' })
    expect(readDraft(keyB)).toBeNull()
    expect(readDraft(keyA)).toEqual({ secret: 'A-data' })
  })
})
