import { describe, expect, it } from 'vitest'
import { pickSpaceIdsForSessionListReconcile } from '../reconcileLoadedChatSessionLists'

describe('pickSpaceIdsForSessionListReconcile ', () => {
  it('puts active space first and caps the list', () => {
    expect(pickSpaceIdsForSessionListReconcile({
      loadedSpaceIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      activeSpaceId: 'c',
      limit: 3,
    })).toEqual(['c', 'a', 'b'])
  })

  it('dedupes and ignores blank ids', () => {
    expect(pickSpaceIdsForSessionListReconcile({
      loadedSpaceIds: ['a', '', 'a', 'b'],
      activeSpaceId: 'missing',
      limit: 10,
    })).toEqual(['a', 'b'])
  })
})
