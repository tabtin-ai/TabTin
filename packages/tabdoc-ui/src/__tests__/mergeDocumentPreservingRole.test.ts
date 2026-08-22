import { describe, expect, it } from 'vitest'
import type { TabdocDocument } from '../api-client'
import { mergeDocumentPreservingRole } from '../mergeDocumentPreservingRole'

function doc(partial: Partial<TabdocDocument> & Pick<TabdocDocument, 'id'>): TabdocDocument {
  return {
    organization_id: 'org-1',
    space_id: 'space-1',
    parent_id: null,
    title: 't',
    status: 'active',
    latest_version: 1,
    icon: '',
    cover_image: '',
    cover_position: 0.5,
    tags: [],
    properties: {},
    is_full_width: false,
    font_style: 'default',
    created_by: null,
    updated_by: null,
    created_at: null,
    updated_at: null,
    ...partial,
  }
}

describe('mergeDocumentPreservingRole', () => {
  it('keeps previous role when next omits current_user_role', () => {
    const prev = doc({ id: 'd1', current_user_role: 'owner', latest_version: 1 })
    const next = doc({ id: 'd1', latest_version: 2 })
    expect(mergeDocumentPreservingRole(prev, next).current_user_role).toBe('owner')
    expect(mergeDocumentPreservingRole(prev, next).latest_version).toBe(2)
  })

  it('keeps previous role when next sets current_user_role to null', () => {
    const prev = doc({ id: 'd1', current_user_role: 'admin' })
    const next = doc({ id: 'd1', current_user_role: null, latest_version: 3 })
    expect(mergeDocumentPreservingRole(prev, next).current_user_role).toBe('admin')
  })

  it('prefers next role when present', () => {
    const prev = doc({ id: 'd1', current_user_role: 'owner' })
    const next = doc({ id: 'd1', current_user_role: 'editor' })
    expect(mergeDocumentPreservingRole(prev, next).current_user_role).toBe('editor')
  })

  it('returns next unchanged when prev has no role', () => {
    const next = doc({ id: 'd1', latest_version: 4 })
    expect(mergeDocumentPreservingRole(null, next)).toBe(next)
    expect(mergeDocumentPreservingRole(doc({ id: 'd1' }), next)).toBe(next)
  })
})
