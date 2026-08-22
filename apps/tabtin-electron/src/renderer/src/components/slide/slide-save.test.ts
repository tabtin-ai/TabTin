import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSlideSaveContext } from './slide-save'

const state = {
  organizationId: 'org-b' as string | null,
  selectedSpace: { id: 'space-a', organization_id: 'org-a' } as {
    id: string
    organization_id: string
  } | null,
}

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      getEffectiveOrganizationId: () => state.organizationId,
    }),
  },
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      selectedSpace: state.selectedSpace,
    }),
  },
}))

describe('getSlideSaveContext', () => {
  beforeEach(() => {
    state.organizationId = 'org-b'
    state.selectedSpace = { id: 'space-a', organization_id: 'org-a' }
  })

  it('does not pair a pending organization with an old Space', () => {
    expect(getSlideSaveContext()).toEqual({
      organizationId: null,
      spaceId: null,
    })
  })

  it('returns the matching organization and Space after the switch', () => {
    state.selectedSpace = { id: 'space-b', organization_id: 'org-b' }

    expect(getSlideSaveContext()).toEqual({
      organizationId: 'org-b',
      spaceId: 'space-b',
    })
  })
})
