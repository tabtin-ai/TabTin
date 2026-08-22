import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import PageList from '../../../../../packages/tabslide/src/panels/PageList'
import { useSlideStore } from '../../../../../packages/tabslide/src/store/slide'
import type { SlidePresentation } from '../../../../../packages/tabslide/src/types/slides'

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[]
    itemContent: (index: number, item: unknown) => React.ReactNode
  }) => (
    <div data-testid="virtuoso-mock-list">
      {data.map((item, index) => itemContent(index, item))}
    </div>
  ),
}))

function makePresentation(): SlidePresentation {
  return {
    id: 'page-list-key-test',
    name: 'PageList Key Test',
    preset: '16:9',
    canvasWidth: 1280,
    canvasHeight: 720,
    pages: [
      {
        id: '',
        elements: [],
        animations: [],
      },
      {
        id: '',
        elements: [],
        animations: [],
      },
      {
        id: 'page-3',
        elements: [],
        animations: [],
      },
    ],
  }
}

describe('TabSlide PageList Key Chain', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
  })

  it('渲染页面缩略图列表时不应出现缺失 key 警告', () => {
    useSlideStore.getState().setPresentation(makePresentation())

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(<PageList />)

      const hasKeyWarning = consoleErrorSpy.mock.calls.some((call) => {
        const firstArg = typeof call[0] === 'string' ? call[0] : ''
        return firstArg.includes('Each child in a list should have a unique "key" prop')
      })

      expect(hasKeyWarning).toBe(false)
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })
})

