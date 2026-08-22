import { describe, it, expect, beforeEach } from 'vitest'
import { attachSlideEditorStoreLifecycle, resetSlideEditorStoreLifecycleForTest } from './slide-editor-store-lifecycle'
import { useSlideStore } from '../store/slide'
import type { SlidePresentation } from '../types/slides'

function makePresentation(id: string): SlidePresentation {
  return {
    id,
    name: id,
    pages: [
      {
        id: `${id}-page-1`,
        elements: [],
        background: { type: 'solid', color: '#FFFFFF' },
      },
    ],
    canvasWidth: 1920,
    canvasHeight: 1080,
    theme: {},
  }
}

describe('slide-editor-store-lifecycle', () => {
  beforeEach(() => {
    resetSlideEditorStoreLifecycleForTest()
    useSlideStore.getState().resetStore()
  })

  it('does not reset the singleton store while another editor remains mounted', () => {
    const cleanupA = attachSlideEditorStoreLifecycle()
    useSlideStore.getState().setPresentation(makePresentation('project-a'))

    const cleanupB = attachSlideEditorStoreLifecycle()
    useSlideStore.getState().setPresentation(makePresentation('project-b'))

    cleanupA()

    expect(useSlideStore.getState().presentation?.id).toBe('project-b')

    cleanupB()

    expect(useSlideStore.getState().presentation).toBeNull()
  })
})
