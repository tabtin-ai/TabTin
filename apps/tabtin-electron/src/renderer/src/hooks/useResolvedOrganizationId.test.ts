import { describe, expect, it } from 'vitest'
import { resolveOrganizationId } from './useResolvedOrganizationId'

describe('resolveOrganizationId ', () => {
  it('keeps an explicit override above every implicit context', () => {
    expect(resolveOrganizationId({
      override: 'org-override',
      pendingOrganizationId: 'org-pending',
      selectedOrganizationId: 'org-b',
      contextOrganizationId: 'org-a',
    })).toBe('org-override')
  })

  it('keeps the Space context outside an organization switch', () => {
    expect(resolveOrganizationId({
      selectedOrganizationId: 'org-b',
      contextOrganizationId: 'org-a',
    })).toBe('org-a')
  })

  it('uses the pending target while the old Space is pending cleanup', () => {
    expect(resolveOrganizationId({
      selectedOrganizationId: 'org-b',
      pendingOrganizationId: 'org-b',
      contextOrganizationId: 'org-a',
    })).toBe('org-b')
  })

  it('falls back to the available context after the switch completes', () => {
    expect(resolveOrganizationId({
      selectedOrganizationId: 'org-b',
      contextOrganizationId: 'org-a',
    })).toBe('org-a')
  })
})
