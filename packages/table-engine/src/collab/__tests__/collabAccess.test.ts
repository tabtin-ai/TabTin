import { describe, expect, it } from 'vitest'
import {
  buildTableCollabConnectionParameters,
  COLLAB_ACCESS_VERIFICATION_UNAVAILABLE,
  COLLAB_PERMISSION_DENIED,
  COLLAB_MODE_REST_PROJECTION,
  FIELD_VISIBILITY_RESTRICTED,
  isRestProjectionAccess,
  parseTableCollabAccessPayload,
  resolveTableCollabDeniedReason,
} from '../collabAccess'

describe('collabAccess ', () => {
  it('detects rest_projection / field_visibility_restricted / authorized=false', () => {
    expect(
      isRestProjectionAccess({
        authorized: false,
        collab_mode: COLLAB_MODE_REST_PROJECTION,
        reason: FIELD_VISIBILITY_RESTRICTED,
      }),
    ).toBe(true)

    expect(
      isRestProjectionAccess({
        authorized: true,
        collab_mode: 'full',
        reason: null,
      }),
    ).toBe(false)

    expect(isRestProjectionAccess(null)).toBe(false)
  })

  it('parses Django envelope and bare payload', () => {
    expect(
      parseTableCollabAccessPayload({
        status: 'ok',
        data: {
          authorized: false,
          collab_mode: 'rest_projection',
          reason: 'field_visibility_restricted',
          visible_field_count: 26,
          total_field_count: 27,
        },
      }),
    ).toEqual({
      authorized: false,
      collab_mode: 'rest_projection',
      reason: 'field_visibility_restricted',
      visible_field_count: 26,
      total_field_count: 27,
      hidden_field_count: undefined,
    })

    expect(
      parseTableCollabAccessPayload({
        authorized: true,
        collab_mode: 'full',
        reason: null,
      }),
    ).toEqual({
      authorized: true,
      collab_mode: 'full',
      reason: null,
      visible_field_count: undefined,
      total_field_count: undefined,
      hidden_field_count: undefined,
    })
  })

  it('builds an optional parent-document handshake context', () => {
    expect(buildTableCollabConnectionParameters(' doc-parent ')).toEqual({
      parent_document_id: 'doc-parent',
    })
    expect(buildTableCollabConnectionParameters(null)).toBeUndefined()
    expect(buildTableCollabConnectionParameters('  ')).toBeUndefined()
  })

  it('separates field projection, temporary verification failure, and permission denial', () => {
    expect(resolveTableCollabDeniedReason({
      authorized: false,
      reason: FIELD_VISIBILITY_RESTRICTED,
    })).toBe(FIELD_VISIBILITY_RESTRICTED)
    expect(resolveTableCollabDeniedReason({
      authorized: false,
      reason: COLLAB_ACCESS_VERIFICATION_UNAVAILABLE,
    })).toBe(COLLAB_ACCESS_VERIFICATION_UNAVAILABLE)
    expect(resolveTableCollabDeniedReason({
      authorized: false,
      reason: '您没有权限执行此操作',
    })).toBe(COLLAB_PERMISSION_DENIED)
  })
})
