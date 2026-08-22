import { describe, expect, it } from 'vitest'

import { getCreateParentPathForEntry } from '../fileTreeCreateTarget'

describe('getCreateParentPathForEntry', () => {
  it('uses the right-clicked folder as the create parent', () => {
    expect(getCreateParentPathForEntry({
      path: '/workspace/src',
      isDirectory: true,
    })).toBe('/workspace/src')
  })

  it('does not allow file rows to host create actions', () => {
    expect(getCreateParentPathForEntry({
      path: '/workspace/src/index.ts',
      isDirectory: false,
    })).toBeNull()
  })
})
