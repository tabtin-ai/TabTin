/**
 * V2 P1 W2-12 回归测试
 *
 * J1-03: per-project saveStatus 隔离
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/id', () => {
  let counter = 0
  return {
    createElementId: () => `el_mock_${++counter}`,
    createPageId: () => `page_mock_${++counter}`,
    createPresentationId: () => `pres_mock_${++counter}`,
    regenerateNestedIds: vi.fn(),
  }
})
vi.mock('../utils/sanitize', () => ({
  sanitizeHtml: vi.fn((html: string) => html),
  sanitizeCssValue: vi.fn((v: string) => v),
  isSafeSrcUrl: vi.fn(() => true),
}))
vi.mock('../utils/line-geometry', () => ({ normalizeLineGeometry: vi.fn((el: unknown) => el) }))
vi.mock('../configs/shapes', () => ({ getShapePath: vi.fn(() => '') }))

import { useSlideStore } from '../store/slide'
import type { SlidePresentation } from '../types/slides'

const makePresentation = (id: string, pageCount = 1): SlidePresentation => ({
  id,
  name: `Pres ${id}`,
  preset: '16:9',
  canvasWidth: 1920,
  canvasHeight: 1080,
  pages: Array.from({ length: pageCount }, (_, i) => ({
    id: `page_${id}_${i}`,
    elements: [],
    background: { type: 'solid' as const, color: '#ffffff' },
  })),
})

describe('J1-03: per-project saveStatus isolation', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
  })

  it('setSaveStatus with projectId different from current does not update top-level', () => {
    const presA = makePresentation('projA')
    useSlideStore.getState().setPresentation(presA)
    useSlideStore.getState().markDirty()
    expect(useSlideStore.getState().saveStatus).toBe('unsaved')

    useSlideStore.getState().setSaveStatus('saved', undefined, 'projB')

    expect(useSlideStore.getState().saveStatus).toBe('unsaved')
    expect(useSlideStore.getState()._projectSaveState['projB']?.status).toBe('saved')
  })

  it('setSaveStatus with matching projectId updates top-level', () => {
    const presA = makePresentation('projA')
    useSlideStore.getState().setPresentation(presA)
    useSlideStore.getState().setSaveStatus('saving', undefined, 'projA')
    expect(useSlideStore.getState().saveStatus).toBe('saving')

    useSlideStore.getState().setSaveStatus('saved', undefined, 'projA')
    expect(useSlideStore.getState().saveStatus).toBe('saved')
  })

  it('switching presentation restores per-project save state', () => {
    const presA = makePresentation('projA')
    const presB = makePresentation('projB')

    useSlideStore.getState().setPresentation(presA)
    useSlideStore.getState().markDirty()
    expect(useSlideStore.getState().saveStatus).toBe('unsaved')

    useSlideStore.getState().setSaveStatus('unsaved', undefined, 'projA')

    useSlideStore.getState().setSaveStatus('saved', undefined, 'projB')

    useSlideStore.getState().setPresentation(presB)
    expect(useSlideStore.getState().saveStatus).toBe('saved')

    useSlideStore.getState().setPresentation(presA)
    expect(useSlideStore.getState().saveStatus).toBe('unsaved')
  })

  it('background tab save (error with projId) does not clobber foreground', () => {
    const presA = makePresentation('projA')
    useSlideStore.getState().setPresentation(presA)
    useSlideStore.getState().setSaveStatus('saving', undefined, 'projA')

    useSlideStore.getState().setSaveStatus('error', '网络超时', 'projB')

    expect(useSlideStore.getState().saveStatus).toBe('saving')
    expect(useSlideStore.getState().saveError).toBeNull()
    expect(useSlideStore.getState()._projectSaveState['projB']?.status).toBe('error')
    expect(useSlideStore.getState()._projectSaveState['projB']?.error).toBe('网络超时')
  })

  it('reset clears _projectSaveState', () => {
    useSlideStore.getState().setPresentation(makePresentation('projA'))
    useSlideStore.getState().setSaveStatus('saved', undefined, 'projA')
    useSlideStore.getState().reset()
    expect(useSlideStore.getState()._projectSaveState).toEqual({})
  })
})
