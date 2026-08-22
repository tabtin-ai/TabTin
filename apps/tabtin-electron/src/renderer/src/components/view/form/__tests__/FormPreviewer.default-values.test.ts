import { describe, expect, it } from 'vitest'

import {
  buildPublicFormSubmitHeaders,
  buildSubmitValues,
  resolveFormCreatorId,
} from '../formSubmitValues'

describe('FormPreviewer default value submission', () => {
  it('does not expose a locally authenticated user as creator on an anonymous public share', () => {
    expect(resolveFormCreatorId({
      currentUserId: 'local-user',
      isAuthenticated: true,
      isPublicShare: true,
      loginRequired: false,
    })).toBeUndefined()
  })

  it.each([
    { label: 'direct submission', isPublicShare: false, loginRequired: false },
    { label: 'login-required public share', isPublicShare: true, loginRequired: true },
  ])('uses the authenticated actor for $label', ({ isPublicShare, loginRequired }) => {
    expect(resolveFormCreatorId({
      currentUserId: 'authenticated-user',
      isAuthenticated: true,
      isPublicShare,
      loginRequired,
    })).toBe('authenticated-user')
  })

  it('only authenticates public submission when an access token is explicitly supplied', () => {
    expect(buildPublicFormSubmitHeaders('secret')).toEqual({
      'Content-Type': 'application/json',
      'X-Form-Password': 'secret',
    })
    expect(buildPublicFormSubmitHeaders(undefined, 'token-1')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer token-1',
    })
  })

  it('preserves an explicitly cleared default value in the submit payload', () => {
    const fields = [
      {
        id: 'field-status',
        name: 'Status',
        field_type: 'select',
        config: {},
        description: '',
        default_value: { mode: 'literal' as const, value: 'Todo' },
      },
    ]

    expect(buildSubmitValues({ 'field-status': '' }, fields)).toEqual({
      'field-status': '',
    })
  })
})
