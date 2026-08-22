import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const spacesState = {
  spaces: [] as Array<{ id: string; type?: string }>,
}

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: (sel: (s: typeof spacesState) => unknown) => sel(spacesState),
}))

import { useSessionComposerAgentIdentityPolicy } from '../useSessionComposerAgentIdentityPolicy'

describe('useSessionComposerAgentIdentityPolicy', () => {
  it('个人 Workspace：可换 Agent，不开放工作空间底栏', () => {
    spacesState.spaces = [{ id: 'space-1', type: 'workspace' }]
    const { result } = renderHook(() => useSessionComposerAgentIdentityPolicy('space-1'))
    expect(result.current).toEqual({
      showAgentIdentity: true,
      canChangeAgent: true,
      enableAgentPicker: false,
    })
  })

  it('team_space：只读身份，不可换 Agent', () => {
    spacesState.spaces = [{ id: 'team-1', type: 'team_space' }]
    const { result } = renderHook(() => useSessionComposerAgentIdentityPolicy('team-1'))
    expect(result.current).toEqual({
      showAgentIdentity: true,
      canChangeAgent: false,
      enableAgentPicker: false,
    })
  })
})
