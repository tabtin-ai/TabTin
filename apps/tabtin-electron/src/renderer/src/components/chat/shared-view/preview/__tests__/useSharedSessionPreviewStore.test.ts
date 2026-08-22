import { beforeEach, describe, expect, it } from 'vitest'
import { useSharedSessionPreviewStore } from '../useSharedSessionPreviewStore'

describe('useSharedSessionPreviewStore', () => {
  beforeEach(() => {
    useSharedSessionPreviewStore.getState().close()
  })

  it('open / close 切换 target', () => {
    expect(useSharedSessionPreviewStore.getState().target).toBeNull()
    useSharedSessionPreviewStore.getState().open({
      sessionId: 's1',
      relativePath: 'a.txt',
      title: 'a.txt',
    })
    expect(useSharedSessionPreviewStore.getState().target).toEqual({
      sessionId: 's1',
      relativePath: 'a.txt',
      title: 'a.txt',
    })
    useSharedSessionPreviewStore.getState().close()
    expect(useSharedSessionPreviewStore.getState().target).toBeNull()
  })
})
